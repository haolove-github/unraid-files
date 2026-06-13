const fs = require("fs");
const fsp = fs.promises;
const http = require("http");
const path = require("path");
const url = require("url");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 8080);
const USER_ROOT = path.resolve(process.env.UNRAID_USER_ROOT || "/mnt/user");
const MNT_ROOT = path.resolve(process.env.UNRAID_MNT_ROOT || "/mnt");
const DEFAULT_WRITE_ROOT = process.env.UNRAID_DEFAULT_WRITE_ROOT
  ? path.resolve(process.env.UNRAID_DEFAULT_WRITE_ROOT)
  : "";
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const PUBLIC_DIR = path.join(__dirname, "public");
const TRASH_DIR_NAME = process.env.UNRAID_TRASH_DIR || ".unraid-files-trash";
const TRASH_MANIFEST_NAME = ".unraid-files-manifest.json";
const TEXT_PREVIEW_BYTES = Number(process.env.UNRAID_TEXT_PREVIEW_BYTES || 1024 * 1024);
const MAX_TEXT_PREVIEW_BYTES = Number.isFinite(TEXT_PREVIEW_BYTES) && TEXT_PREVIEW_BYTES > 0
  ? Math.floor(TEXT_PREVIEW_BYTES)
  : 1024 * 1024;
const AUTH_USER = process.env.UNRAID_AUTH_USER || "admin";
const AUTH_PASSWORD = process.env.UNRAID_AUTH_PASSWORD || "";
const JOB_RETENTION_MS = (() => {
  const value = Number(process.env.UNRAID_JOB_RETENTION_MS || 24 * 60 * 60 * 1000);
  return Number.isFinite(value) && value >= 0 ? value : 24 * 60 * 60 * 1000;
})();
const MAX_JOB_HISTORY = (() => {
  const value = Number(process.env.UNRAID_MAX_JOB_HISTORY || 200);
  return Number.isInteger(value) && value >= 0 ? value : 200;
})();
const LIST_ENTRY_CONCURRENCY = 16;
const SEARCH_DIRECTORY_CONCURRENCY = 8;
const SEARCH_MATCH_CONCURRENCY = 16;

const TEXT_PREVIEW_EXTENSIONS = new Set([
  "bash", "c", "cfg", "conf", "cpp", "cs", "css", "csv", "dart", "env", "fish",
  "go", "h", "hpp", "htm", "html", "ini", "java", "js", "json", "jsx", "kt",
  "kts", "log", "lua", "md", "mjs", "php", "pl", "properties", "py", "rb",
  "rs", "scss", "sh", "sql", "svg", "svelte", "toml", "ts", "tsx", "tsv",
  "txt", "vue", "xml", "yaml", "yml", "zsh",
]);

const TEXT_PREVIEW_NAMES = new Set([
  ".dockerignore", ".env", ".gitignore", "dockerfile", "makefile", "readme",
]);
const HIDDEN_DOCKER_CONTAINERS = new Set(["unraid-files", "nas-file-manager"]);
const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

let rootsCache = { at: 0, value: [] };
let dockerCache = { at: 0, value: [] };
const jobs = new Map();

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

class JobCanceledError extends Error {
  constructor(result = null) {
    super("Job canceled");
    this.code = "JOB_CANCELED";
    this.result = result;
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function text(res, status, payload) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(payload);
}

function fail(res, status, message, details) {
  json(res, status, { error: message, details });
}

function badRequest(message, details) {
  throw new HttpError(400, message, details);
}

function conflict(message, details) {
  throw new HttpError(409, message, details);
}

function parseBoundedInt(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    badRequest(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseBoundedNumber(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    badRequest(`${name} must be a number between ${min} and ${max}`);
  }
  return parsed;
}

function parseOptionalDateMs(value, name) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) badRequest(`${name} must be a valid date`);
  return parsed;
}

async function mapConcurrent(items, limit, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(limit || 1, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  return results;
}

function compareNatural(a, b) {
  return naturalCollator.compare(String(a), String(b));
}

function decodeBasicAuth(header) {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const raw = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = raw.indexOf(":");
    if (idx < 0) return null;
    return { user: raw.slice(0, idx), password: raw.slice(idx + 1) };
  } catch {
    return null;
  }
}

function requireAuth(req, res) {
  if (!AUTH_PASSWORD) return true;
  const auth = decodeBasicAuth(req.headers.authorization || "");
  if (auth && auth.user === AUTH_USER && auth.password === AUTH_PASSWORD) return true;
  res.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "www-authenticate": 'Basic realm="Unraid Files"',
  });
  res.end("Authentication required");
  return false;
}

function normalizeLogical(input) {
  const raw = String(input || USER_ROOT);
  if (raw.includes("\0")) throw new Error("Invalid path");

  let candidate;
  if (raw === "/" || raw === ".") {
    candidate = USER_ROOT;
  } else if (path.isAbsolute(raw)) {
    candidate = path.resolve(raw);
  } else {
    candidate = path.resolve(USER_ROOT, raw);
  }

  if (candidate !== USER_ROOT && !candidate.startsWith(USER_ROOT + path.sep)) {
    throw new Error(`Path must stay under ${USER_ROOT}`);
  }
  return candidate;
}

function relFromUser(logicalPath) {
  const rel = path.relative(USER_ROOT, logicalPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Invalid relative path");
  return rel;
}

function isSameOrChild(child, parent) {
  if (!child || !parent) return false;
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function statSafe(p) {
  try {
    return await fsp.lstat(p);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

async function existsDir(p) {
  const st = await statSafe(p);
  return Boolean(st && st.isDirectory());
}

async function existsLogicalOrReal(logicalPath) {
  const st = await statSafe(logicalPath);
  if (st) return true;
  const locations = await resolveLocations(logicalPath);
  return locations.length > 0;
}

async function getStorageRoots() {
  const now = Date.now();
  if (now - rootsCache.at < 5000) return rootsCache.value;

  const explicit = process.env.UNRAID_REAL_ROOTS;
  if (explicit) {
    const value = explicit
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => path.resolve(item));
    rootsCache = { at: now, value };
    return value;
  }

  let names = [];
  try {
    names = await fsp.readdir(MNT_ROOT);
  } catch {
    rootsCache = { at: now, value: [] };
    return [];
  }

  const candidates = [];
  const ignoredMountNames = new Set(["user", "user0", "disks", "remotes", "addons", "rootshare"]);
  const checks = names.map(async (name) => {
    if (ignoredMountNames.has(name)) return null;
    if (name.startsWith(".")) return null;
    const full = path.join(MNT_ROOT, name);
    const st = await statSafe(full);
    if (!st || !st.isDirectory()) return null;
    if (/^disk\d+$/.test(name) || name === "cache" || name === "pool" || !name.includes(".")) {
      return full;
    }
    return null;
  });
  const checkedCandidates = await Promise.all(checks);
  for (const candidate of checkedCandidates) {
    if (candidate) candidates.push(candidate);
  }

  candidates.sort((a, b) => {
    const an = path.basename(a);
    const bn = path.basename(b);
    const ad = /^disk(\d+)$/.exec(an);
    const bd = /^disk(\d+)$/.exec(bn);
    if (ad && bd) return Number(ad[1]) - Number(bd[1]);
    if (ad) return -1;
    if (bd) return 1;
    return an.localeCompare(bn);
  });

  rootsCache = { at: now, value: candidates };
  return candidates;
}

async function resolveLocations(logicalPath) {
  const rel = relFromUser(logicalPath);
  const roots = await getStorageRoots();
  const checks = await Promise.all(roots.map(async (root) => {
    const realPath = rel ? path.join(root, rel) : root;
    const st = await statSafe(realPath);
    if (!st) return null;
    return {
      root,
      disk: path.basename(root),
      path: realPath,
      type: statType(st),
      size: st.size,
      mtime: st.mtimeMs,
    };
  }));

  return checks.filter(Boolean);
}

function statType(st) {
  if (st.isDirectory()) return "directory";
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFile()) return "file";
  return "other";
}

function isTextPreviewName(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(base).slice(1);
  return TEXT_PREVIEW_NAMES.has(base) || TEXT_PREVIEW_EXTENSIONS.has(ext);
}

function hasBinaryMarker(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}

async function dockerRequest(apiPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path: apiPath, method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Docker API ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body || "null"));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function getDockerMounts() {
  const now = Date.now();
  if (now - dockerCache.at < 10000) return dockerCache.value;

  const socketExists = await statSafe(DOCKER_SOCKET);
  if (!socketExists) {
    dockerCache = { at: now, value: [] };
    return [];
  }

  try {
    const containers = await dockerRequest("/containers/json?all=1");
    const mounts = [];
    for (const container of containers || []) {
      const name = (container.Names && container.Names[0] ? container.Names[0] : container.Id || "")
        .replace(/^\//, "");
      if (HIDDEN_DOCKER_CONTAINERS.has(name)) continue;
      for (const mount of container.Mounts || []) {
        if (!mount.Source) continue;
        if (path.resolve(mount.Source) === MNT_ROOT && mount.Destination === MNT_ROOT) continue;
        mounts.push({
          containerId: container.Id,
          container: name,
          image: container.Image,
          state: container.State,
          source: path.resolve(mount.Source),
          destination: mount.Destination,
          mode: mount.Mode || "",
          rw: mount.RW !== false,
          type: mount.Type || "bind",
        });
      }
    }
    dockerCache = { at: now, value: mounts };
    return mounts;
  } catch {
    dockerCache = { at: now, value: [] };
    return [];
  }
}

function matchDockerMounts(logicalPath, locations, mounts) {
  if (logicalPath === USER_ROOT) return [];
  const paths = [logicalPath, ...locations.map((item) => item.path)];
  return mounts
    .filter((mount) => paths.some((p) => isSameOrChild(p, mount.source) || isSameOrChild(mount.source, p)))
    .map((mount) => ({
      container: mount.container,
      image: mount.image,
      state: mount.state,
      source: mount.source,
      destination: mount.destination,
      rw: mount.rw,
      type: mount.type,
    }));
}

async function makeEntry(logicalPath, dirent, dockerMounts) {
  const name = dirent ? dirent.name : path.basename(logicalPath);
  const [st, locations] = await Promise.all([
    statSafe(logicalPath),
    resolveLocations(logicalPath),
  ]);
  const mounts = matchDockerMounts(logicalPath, locations, dockerMounts);

  return {
    name,
    path: logicalPath,
    relativePath: relFromUser(logicalPath),
    type: st ? statType(st) : locations[0]?.type || "missing",
    size: st ? st.size : locations.reduce((sum, item) => sum + item.size, 0),
    mtime: st ? st.mtimeMs : Math.max(0, ...locations.map((item) => item.mtime)),
    mode: st ? st.mode & 0o7777 : null,
    uid: st ? st.uid : null,
    gid: st ? st.gid : null,
    extension: path.extname(name).slice(1).toLowerCase(),
    disk: locations.length === 1 ? locations[0].disk : locations.length > 1 ? "split" : "",
    locations,
    dockerMounts: mounts,
  };
}

async function listDirectory(req, res, query) {
  const logicalPath = normalizeLogical(query.path || USER_ROOT);
  const st = await statSafe(logicalPath);
  if (!st) return fail(res, 404, "Path not found");
  if (!st.isDirectory()) return fail(res, 400, "Path is not a directory");

  const [dirents, dockerMounts] = await Promise.all([
    fsp.readdir(logicalPath, { withFileTypes: true }),
    getDockerMounts(),
  ]);

  const visibleDirents = dirents.filter((dirent) => !(dirent.name === TRASH_DIR_NAME && logicalPath === USER_ROOT));
  const [entries, current] = await Promise.all([
    mapConcurrent(
      visibleDirents,
      LIST_ENTRY_CONCURRENCY,
      (dirent) => makeEntry(path.join(logicalPath, dirent.name), dirent, dockerMounts)
    ),
    makeEntry(logicalPath, null, dockerMounts),
  ]);

  entries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return compareNatural(a.name, b.name);
  });

  const parent = logicalPath === USER_ROOT ? "" : path.dirname(logicalPath);
  json(res, 200, { root: USER_ROOT, path: logicalPath, parent, current, entries });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function ensureSafeName(name) {
  const value = String(name || "").trim();
  if (!value || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error("Invalid name");
  }
  if (value === "." || value === "..") throw new Error("Invalid name");
  return value;
}

function copyName(name, index, isFile) {
  const suffix = index === 1 ? " copy" : ` copy ${index}`;
  if (!isFile) return `${name}${suffix}`;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  return `${base}${suffix}${ext}`;
}

async function chooseAutoDestination(srcLogical, destLogical, reservedLogical) {
  const srcStat = await statSafe(srcLogical);
  const isFile = Boolean(srcStat && srcStat.isFile());
  const dir = path.dirname(destLogical);
  const name = path.basename(destLogical);
  for (let idx = 0; idx <= 999; idx += 1) {
    const candidate = idx === 0 ? destLogical : path.join(dir, copyName(name, idx, isFile));
    if (reservedLogical.has(candidate)) continue;
    if (!(await existsLogicalOrReal(candidate))) return candidate;
  }
  throw new HttpError(409, `Could not find an available name for ${name}`);
}

async function buildTransferSteps(operation, srcLogical, destLogical, overwrite, reservedReal) {
  if (srcLogical === USER_ROOT) badRequest(`Cannot ${operation} the root path`);
  if (operation === "move" && srcLogical === destLogical) {
    conflict("Destination is the same as the source");
  }
  if (isSameOrChild(destLogical, srcLogical)) {
    conflict(`Cannot ${operation} a folder into itself`);
  }

  const srcStat = await statSafe(srcLogical);
  const srcLocations = await resolveLocations(srcLogical);
  if (!srcStat && !srcLocations.length) throw new HttpError(404, "Source not found");

  const relDest = relFromUser(destLogical);
  const steps = [];

  if (srcLocations.length) {
    for (const loc of srcLocations) {
      const destReal = path.join(loc.root, relDest);
      const key = path.resolve(destReal);
      if (reservedReal.has(key)) conflict(`Destination selected more than once: ${destReal}`);
      reservedReal.add(key);
      const existing = await statSafe(destReal);
      if (existing && !overwrite) conflict(`Destination exists: ${destReal}`);
      steps.push({ operation, from: loc.path, to: destReal, disk: loc.disk, overwrite });
    }
    return steps;
  }

  const key = path.resolve(destLogical);
  if (reservedReal.has(key)) conflict(`Destination selected more than once: ${destLogical}`);
  reservedReal.add(key);
  const existing = await statSafe(destLogical);
  if (existing && !overwrite) conflict(`Destination exists: ${destLogical}`);
  steps.push({ operation, from: srcLogical, to: destLogical, disk: "logical", overwrite });
  return steps;
}

async function buildTransferPlan(operation, sources, destination, options = {}) {
  if (!Array.isArray(sources) || !sources.length) badRequest("No sources provided");
  const destDir = normalizeLogical(destination);
  if (!(await existsDir(destDir))) badRequest("Destination is not a directory");

  const overwrite = Boolean(options.overwrite);
  const autoRename = Boolean(options.autoRename);
  const reservedLogical = new Set();
  const reservedReal = new Set();
  const items = [];
  const steps = [];

  for (const source of sources) {
    const srcLogical = normalizeLogical(source);
    const name = path.basename(srcLogical);
    let destLogical = path.join(destDir, name);
    if (autoRename && operation === "copy") {
      destLogical = await chooseAutoDestination(srcLogical, destLogical, reservedLogical);
    } else if (reservedLogical.has(destLogical)) {
      conflict(`Destination selected more than once: ${destLogical}`);
    }
    reservedLogical.add(destLogical);
    const itemSteps = await buildTransferSteps(operation, srcLogical, destLogical, overwrite, reservedReal);
    items.push({ source: srcLogical, destination: destLogical, steps: itemSteps });
    steps.push(...itemSteps);
  }

  return { operation, overwrite, autoRename, items, steps };
}

function toExecutionHooks(hooks) {
  if (typeof hooks === "function") return { onProgress: hooks };
  return hooks || {};
}

function ensureJobNotCanceled(isCanceled, result) {
  if (isCanceled && isCanceled()) throw new JobCanceledError(result);
}

async function executeTransferPlan(plan, hooks) {
  const { onProgress, isCanceled } = toExecutionHooks(hooks);
  const results = [];
  for (const step of plan.steps) {
    ensureJobNotCanceled(isCanceled, results);
    await fsp.mkdir(path.dirname(step.to), { recursive: true });
    const existing = await statSafe(step.to);
    if (existing && step.overwrite) await fsp.rm(step.to, { recursive: true, force: true });
    if (step.operation === "copy") {
      await fsp.cp(step.from, step.to, { recursive: true, errorOnExist: !step.overwrite, force: step.overwrite });
    } else {
      await fsp.rename(step.from, step.to);
    }
    const result = { from: step.from, to: step.to, disk: step.disk };
    results.push(result);
    if (onProgress) onProgress(result);
  }
  return results;
}

async function handleMove(req, res) {
  const body = await parseBody(req);
  const plan = await buildTransferPlan("move", body.sources, body.destination, {
    overwrite: body.overwrite,
  });
  const moves = await executeTransferPlan(plan);
  json(res, 200, { moved: plan.items.map((item) => ({
    source: item.source,
    destination: item.destination,
    moves: moves.filter((move) => item.steps.some((step) => step.from === move.from && step.to === move.to)),
  })) });
}

async function handleCopy(req, res) {
  const body = await parseBody(req);
  const plan = await buildTransferPlan("copy", body.sources, body.destination, {
    overwrite: body.overwrite,
    autoRename: body.autoRename,
  });
  const copies = await executeTransferPlan(plan);
  json(res, 200, { copied: plan.items.map((item) => ({
    source: item.source,
    destination: item.destination,
    copies: copies.filter((copy) => item.steps.some((step) => step.from === copy.from && step.to === copy.to)),
  })) });
}

async function handleRename(req, res) {
  const body = await parseBody(req);
  const srcLogical = normalizeLogical(body.path);
  const newName = ensureSafeName(body.name);
  const destLogical = path.join(path.dirname(srcLogical), newName);
  const plan = {
    steps: await buildTransferSteps("move", srcLogical, destLogical, Boolean(body.overwrite), new Set()),
  };
  const moves = await executeTransferPlan(plan);
  json(res, 200, { source: srcLogical, destination: destLogical, moves });
}

async function chooseMkdirPath(parentLogical, name) {
  const parentLocations = await resolveLocations(parentLogical);
  if (parentLocations.length === 1) return path.join(parentLocations[0].path, name);
  if (DEFAULT_WRITE_ROOT) return path.join(DEFAULT_WRITE_ROOT, relFromUser(parentLogical), name);
  if (parentLocations.length > 1 && typeof fsp.statfs === "function") {
    let best = null;
    for (const loc of parentLocations) {
      try {
        const sf = await fsp.statfs(loc.root);
        const free = Number(sf.bavail) * Number(sf.bsize);
        if (!best || free > best.free) best = { loc, free };
      } catch {
        // Ignore roots whose free space cannot be read.
      }
    }
    if (best) return path.join(best.loc.path, name);
  }
  if (parentLocations.length > 1) return path.join(parentLocations[0].path, name);
  return path.join(parentLogical, name);
}

async function handleMkdir(req, res) {
  const body = await parseBody(req);
  const parent = normalizeLogical(body.parent || USER_ROOT);
  const name = ensureSafeName(body.name);
  const actual = await chooseMkdirPath(parent, name);
  await fsp.mkdir(actual, { recursive: false });
  json(res, 201, { path: path.join(parent, name), actual });
}

function attachmentHeader(filename) {
  const fallback = String(filename || "download").replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename || "download")}`;
}

async function handleUpload(req, res, query) {
  const parent = normalizeLogical(query.parent || USER_ROOT);
  const parentStat = await statSafe(parent);
  if (!parentStat || !parentStat.isDirectory()) badRequest("Upload parent is not a directory");
  const encodedName = req.headers["x-file-name"];
  if (!encodedName) badRequest("Missing x-file-name header");
  let decodedName;
  try {
    decodedName = decodeURIComponent(String(encodedName));
  } catch {
    badRequest("Invalid x-file-name header");
  }
  const name = ensureSafeName(decodedName);
  const logicalPath = path.join(parent, name);
  const overwrite = query.overwrite === "true";
  const [logicalStat, locations] = await Promise.all([statSafe(logicalPath), resolveLocations(logicalPath)]);
  const exists = Boolean(logicalStat || locations.length);
  if (!overwrite && exists) conflict("Destination exists", { path: logicalPath });
  if (overwrite && exists) {
    if ((logicalStat && !logicalStat.isFile()) || locations.some((location) => location.type !== "file")) {
      conflict("Upload cannot overwrite a non-file destination", { path: logicalPath });
    }
    if (locations.length > 1) {
      conflict("Upload cannot overwrite a file stored on multiple roots", { path: logicalPath });
    }
  }
  const actual = locations.length === 1 ? locations[0].path : await chooseMkdirPath(parent, name);

  await fsp.mkdir(path.dirname(actual), { recursive: true });
  const temp = path.join(path.dirname(actual), `.${path.basename(actual)}.upload-${crypto.randomBytes(6).toString("hex")}`);
  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(temp, { flags: "wx" });
      req.on("aborted", () => reject(new Error("Upload aborted")));
      req.on("error", reject);
      output.on("error", reject);
      output.on("finish", resolve);
      req.pipe(output);
    });
    if (overwrite) await fsp.rm(actual, { force: true });
    await fsp.rename(temp, actual);
    const st = await fsp.stat(actual);
    json(res, 201, { path: logicalPath, actual, size: st.size });
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

async function handleArchiveDownload(req, res, query) {
  const values = Array.isArray(query.path) ? query.path : query.path ? [query.path] : [];
  if (!values.length) badRequest("No archive paths provided");
  if (values.length > 200) badRequest("Too many archive paths");
  const logicalPaths = values.map(normalizeLogical);
  for (const logicalPath of logicalPaths) {
    if (!(await statSafe(logicalPath))) throw new HttpError(404, `Path not found: ${logicalPath}`);
  }
  const relatives = logicalPaths.map((logicalPath) => `./${relFromUser(logicalPath) || "."}`);
  const filename = ensureSafeName(query.name || `unraid-files-${new Date().toISOString().slice(0, 10)}.tar`);
  res.writeHead(200, {
    "content-type": "application/x-tar",
    "content-disposition": attachmentHeader(filename.endsWith(".tar") ? filename : `${filename}.tar`),
  });
  const tar = spawn("tar", ["-cf", "-", "-C", USER_ROOT, ...relatives], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  tar.stderr.on("data", (chunk) => {
    if (stderr.length < 4096) stderr += chunk.toString();
  });
  tar.on("error", (err) => res.destroy(err));
  tar.on("close", (code) => {
    if (code !== 0 && !res.destroyed) res.destroy(new Error(stderr.trim() || `tar exited with ${code}`));
  });
  res.on("close", () => {
    if (!tar.killed) tar.kill();
  });
  tar.stdout.pipe(res);
}

async function handleChecksum(req, res, query) {
  const logicalPath = normalizeLogical(query.path);
  const st = await statSafe(logicalPath);
  if (!st || !st.isFile()) return fail(res, 404, "File not found");
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(logicalPath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  json(res, 200, { path: logicalPath, algorithm: "sha256", checksum: hash.digest("hex"), size: st.size });
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    return fallback;
  }
}

async function appendTrashManifest(root, stamp, entries) {
  if (!entries.length) return;
  const manifestPath = path.join(root, TRASH_DIR_NAME, stamp, TRASH_MANIFEST_NAME);
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  const current = await readJsonFile(manifestPath, []);
  const next = Array.isArray(current) ? current.concat(entries) : entries;
  await fsp.writeFile(manifestPath, JSON.stringify(next, null, 2));
}

function trashManifestPath(root, stamp) {
  return path.join(root, TRASH_DIR_NAME, stamp, TRASH_MANIFEST_NAME);
}

async function pruneEmptyDirsWithin(startDir, stopDir) {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  if (!isSameOrChild(current, stop)) return;

  while (isSameOrChild(current, stop)) {
    try {
      await fsp.rmdir(current);
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTEMPTY" || err.code === "EEXIST")) return;
      throw err;
    }
    if (current === stop) return;
    current = path.dirname(current);
  }
}

async function removeTrashManifestRefs(refs) {
  const grouped = new Map();
  for (const ref of refs) {
    const key = `${ref.root}\0${ref.stamp}`;
    if (!grouped.has(key)) grouped.set(key, { root: ref.root, stamp: ref.stamp, trashPaths: new Set() });
    grouped.get(key).trashPaths.add(path.resolve(ref.trashPath));
  }

  for (const group of grouped.values()) {
    const manifestPath = trashManifestPath(group.root, group.stamp);
    const manifest = await readJsonFile(manifestPath, null);
    if (!Array.isArray(manifest)) continue;

    const next = manifest.filter((item) => !group.trashPaths.has(path.resolve(item.trashPath || "")));
    if (next.length) {
      await fsp.writeFile(manifestPath, JSON.stringify(next, null, 2));
    } else {
      await fsp.rm(manifestPath, { force: true });
    }
  }
}

async function cleanupTrashRefs(refs) {
  if (!refs.length) return;
  await removeTrashManifestRefs(refs);
  for (const ref of refs) {
    const stampPath = path.join(ref.root, TRASH_DIR_NAME, ref.stamp);
    await pruneEmptyDirsWithin(path.dirname(ref.trashPath), stampPath);
  }
}

async function buildDeletePlan(paths, permanent) {
  if (!Array.isArray(paths) || !paths.length) badRequest("No paths provided");

  const normalized = [];
  for (const item of paths) {
    const logicalPath = normalizeLogical(item);
    if (logicalPath === USER_ROOT) badRequest("Cannot delete the root path");
    normalized.push(logicalPath);
  }

  normalized.sort((a, b) => a.length - b.length);
  const deduped = [];
  for (const logicalPath of normalized) {
    if (deduped.some((parent) => isSameOrChild(logicalPath, parent))) continue;
    deduped.push(logicalPath);
  }

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const steps = [];
  const reservedTrash = new Set();

  for (const logicalPath of deduped) {
    const locations = await resolveLocations(logicalPath);
    const rel = relFromUser(logicalPath);
    if (locations.length) {
      for (const loc of locations) {
        const trashPath = path.join(loc.root, TRASH_DIR_NAME, stamp, rel);
        if (!permanent) {
          const key = path.resolve(trashPath);
          if (reservedTrash.has(key)) conflict(`Trash destination selected more than once: ${trashPath}`);
          reservedTrash.add(key);
          if (await statSafe(trashPath)) conflict(`Trash destination exists: ${trashPath}`);
        }
        steps.push({
          source: loc.path,
          originalLogical: logicalPath,
          originalActual: loc.path,
          trashPath,
          manifestRoot: loc.root,
          disk: loc.disk,
          permanent,
          type: loc.type,
          size: loc.size,
          mtime: loc.mtime,
        });
      }
      continue;
    }

    const st = await statSafe(logicalPath);
    if (!st) throw new HttpError(404, "Path not found");
    const trashPath = path.join(USER_ROOT, TRASH_DIR_NAME, stamp, rel);
    if (!permanent) {
      const key = path.resolve(trashPath);
      if (reservedTrash.has(key)) conflict(`Trash destination selected more than once: ${trashPath}`);
      reservedTrash.add(key);
      if (await statSafe(trashPath)) conflict(`Trash destination exists: ${trashPath}`);
    }
    steps.push({
      source: logicalPath,
      originalLogical: logicalPath,
      originalActual: logicalPath,
      trashPath,
      manifestRoot: USER_ROOT,
      disk: "logical",
      permanent,
      type: statType(st),
      size: st.size,
      mtime: st.mtimeMs,
    });
  }

  return { stamp, steps };
}

async function executeDeletePlan(plan, hooks) {
  const { onProgress, isCanceled } = toExecutionHooks(hooks);
  const deleted = [];
  const manifestEntries = new Map();
  const deletedAt = new Date().toISOString();

  for (const step of plan.steps) {
    ensureJobNotCanceled(isCanceled, deleted);
    if (step.permanent) {
      await fsp.rm(step.source, { recursive: true, force: true });
      deleted.push({ path: step.source, permanent: true, disk: step.disk });
    } else {
      await fsp.mkdir(path.dirname(step.trashPath), { recursive: true });
      await fsp.rename(step.source, step.trashPath);
      deleted.push({ path: step.source, trash: step.trashPath, disk: step.disk });
      const entry = {
        deletedAt,
        stamp: plan.stamp,
        originalLogical: step.originalLogical,
        originalActual: step.originalActual,
        trashPath: step.trashPath,
        disk: step.disk,
        type: step.type,
        size: step.size,
        mtime: step.mtime,
      };
      if (!manifestEntries.has(step.manifestRoot)) manifestEntries.set(step.manifestRoot, []);
      manifestEntries.get(step.manifestRoot).push(entry);
    }
    if (onProgress) onProgress(step);
  }

  for (const [root, entries] of manifestEntries) {
    await appendTrashManifest(root, plan.stamp, entries);
  }

  return deleted;
}

async function handleDelete(req, res) {
  const body = await parseBody(req);
  const permanent = Boolean(body.permanent);
  const plan = await buildDeletePlan(body.paths, permanent);
  const deleted = await executeDeletePlan(plan);
  json(res, 200, { deleted });
}

function encodeTrashRef(ref) {
  return Buffer.from(JSON.stringify(ref)).toString("base64url");
}

function decodeTrashRef(id) {
  try {
    return JSON.parse(Buffer.from(String(id || ""), "base64url").toString("utf8"));
  } catch {
    badRequest("Invalid trash item id");
  }
}

async function getTrashRoots() {
  const roots = await getStorageRoots();
  return [...new Set([...roots, USER_ROOT])];
}

async function normalizeTrashRef(id) {
  const ref = decodeTrashRef(id);
  const roots = await getTrashRoots();
  const root = path.resolve(ref.root || "");
  if (!roots.includes(root)) badRequest("Invalid trash root");
  const trashRoot = path.join(root, TRASH_DIR_NAME);
  const stamp = String(ref.stamp || "");
  if (!stamp || stamp.includes("/") || stamp.includes("\\") || stamp.includes("\0")) {
    badRequest("Invalid trash stamp");
  }
  const stampPath = path.join(trashRoot, stamp);
  const trashPath = path.resolve(ref.trashPath || "");
  if (!isSameOrChild(trashPath, stampPath)) badRequest("Invalid trash path");
  const originalLogical = normalizeLogical(ref.originalLogical || USER_ROOT);
  const originalActual = path.resolve(ref.originalActual || path.join(root, relFromUser(originalLogical)));
  if (root === USER_ROOT) {
    if (!isSameOrChild(originalActual, USER_ROOT)) badRequest("Invalid restore path");
  } else if (!isSameOrChild(originalActual, root)) {
    badRequest("Invalid restore path");
  }
  return {
    root,
    stamp,
    disk: String(ref.disk || path.basename(root)),
    trashPath,
    originalLogical,
    originalActual,
  };
}

async function fallbackTrashEntries(root, stamp, stampPath) {
  const entries = [];
  let dirents = [];
  try {
    dirents = await fsp.readdir(stampPath, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const dirent of dirents) {
    if (dirent.name === TRASH_MANIFEST_NAME) continue;
    const trashPath = path.join(stampPath, dirent.name);
    const st = await statSafe(trashPath);
    if (!st) continue;
    const originalLogical = path.join(USER_ROOT, dirent.name);
    const ref = {
      root,
      stamp,
      disk: root === USER_ROOT ? "logical" : path.basename(root),
      trashPath,
      originalLogical,
      originalActual: root === USER_ROOT ? originalLogical : path.join(root, dirent.name),
    };
    entries.push({
      id: encodeTrashRef(ref),
      ...ref,
      name: dirent.name,
      type: statType(st),
      size: st.size,
      mtime: st.mtimeMs,
      deletedAt: stamp,
      manifest: false,
    });
  }
  return entries;
}

async function handleTrashList(req, res) {
  const roots = await getTrashRoots();
  const entries = [];
  for (const root of roots) {
    const trashRoot = path.join(root, TRASH_DIR_NAME);
    let stamps = [];
    try {
      stamps = await fsp.readdir(trashRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const stampDir of stamps) {
      if (!stampDir.isDirectory()) continue;
      const stamp = stampDir.name;
      const stampPath = path.join(trashRoot, stamp);
      const manifestPath = path.join(stampPath, TRASH_MANIFEST_NAME);
      const manifest = await readJsonFile(manifestPath, null);
      if (!Array.isArray(manifest)) {
        entries.push(...await fallbackTrashEntries(root, stamp, stampPath));
        continue;
      }
      for (const item of manifest) {
        const trashPath = path.resolve(item.trashPath || "");
        if (!isSameOrChild(trashPath, trashRoot)) continue;
        const st = await statSafe(trashPath);
        if (!st) continue;
        const originalLogical = normalizeLogical(item.originalLogical || USER_ROOT);
        const originalActual = path.resolve(item.originalActual || path.join(root, relFromUser(originalLogical)));
        const ref = {
          root,
          stamp,
          disk: item.disk || (root === USER_ROOT ? "logical" : path.basename(root)),
          trashPath,
          originalLogical,
          originalActual,
        };
        entries.push({
          id: encodeTrashRef(ref),
          ...ref,
          name: path.basename(originalLogical),
          type: item.type || statType(st),
          size: item.size ?? st.size,
          mtime: item.mtime ?? st.mtimeMs,
          deletedAt: item.deletedAt || stamp,
          manifest: true,
        });
      }
    }
  }
  entries.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  json(res, 200, { entries, trashDirName: TRASH_DIR_NAME });
}

async function handleTrashRestore(req, res) {
  const body = await parseBody(req);
  const ids = Array.isArray(body.items) ? body.items : [];
  const overwrite = Boolean(body.overwrite);
  if (!ids.length) badRequest("No trash items provided");
  const refs = [];
  for (const id of ids) {
    const ref = await normalizeTrashRef(id);
    if (!(await statSafe(ref.trashPath))) throw new HttpError(404, "Trash item not found");
    if ((await statSafe(ref.originalActual)) && !overwrite) {
      conflict(`Destination exists: ${ref.originalActual}`);
    }
    refs.push(ref);
  }
  const restored = [];
  const completedRefs = [];
  for (const ref of refs) {
    await fsp.mkdir(path.dirname(ref.originalActual), { recursive: true });
    const existing = await statSafe(ref.originalActual);
    if (existing && overwrite) await fsp.rm(ref.originalActual, { recursive: true, force: true });
    await fsp.rename(ref.trashPath, ref.originalActual);
    completedRefs.push(ref);
    restored.push({ from: ref.trashPath, to: ref.originalActual, disk: ref.disk });
  }
  await cleanupTrashRefs(completedRefs);
  json(res, 200, { restored });
}

async function handleTrashPurge(req, res) {
  const body = await parseBody(req);
  const ids = Array.isArray(body.items) ? body.items : [];
  if (!ids.length) badRequest("No trash items provided");
  const refs = [];
  for (const id of ids) {
    const ref = await normalizeTrashRef(id);
    if (!(await statSafe(ref.trashPath))) throw new HttpError(404, "Trash item not found");
    refs.push(ref);
  }
  const purged = [];
  const completedRefs = [];
  for (const ref of refs) {
    await fsp.rm(ref.trashPath, { recursive: true, force: true });
    completedRefs.push(ref);
    purged.push({ path: ref.trashPath, disk: ref.disk });
  }
  await cleanupTrashRefs(completedRefs);
  json(res, 200, { purged });
}

function serializeJob(job) {
  return {
    id: job.id,
    operation: job.operation,
    status: job.status,
    total: job.total,
    completed: job.completed,
    message: job.message,
    result: job.result,
    error: job.error,
    cancelRequested: Boolean(job.cancelRequested),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function createJob(operation, total) {
  cleanupJobs();
  const now = new Date().toISOString();
  const id = crypto.randomBytes(8).toString("hex");
  const job = {
    id,
    operation,
    status: "queued",
    total,
    completed: 0,
    message: "Queued",
    result: null,
    error: null,
    cancelRequested: false,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(id, job);
  return job;
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function cleanupJobs(now = Date.now()) {
  const terminalJobs = [];
  for (const [id, job] of jobs) {
    if (!["done", "error", "canceled"].includes(job.status)) continue;
    const updatedAt = Date.parse(job.updatedAt) || 0;
    if (JOB_RETENTION_MS === 0 || now - updatedAt > JOB_RETENTION_MS) {
      jobs.delete(id);
      continue;
    }
    terminalJobs.push([id, updatedAt]);
  }

  if (terminalJobs.length <= MAX_JOB_HISTORY) return;
  terminalJobs.sort((a, b) => b[1] - a[1]);
  for (const [id] of terminalJobs.slice(MAX_JOB_HISTORY)) {
    jobs.delete(id);
  }
}

function runJob(job, runner) {
  setImmediate(async () => {
    if (job.cancelRequested) {
      updateJob(job, { status: "canceled", message: "Canceled" });
      return;
    }
    updateJob(job, { status: "running", message: "Running" });
    try {
      const isCanceled = () => Boolean(job.cancelRequested);
      const progress = (message) => {
        updateJob(job, {
          completed: Math.min(job.total, job.completed + 1),
          message,
        });
      };
      const result = await runner({ progress, isCanceled });
      if (isCanceled()) {
        updateJob(job, {
          status: "canceled",
          message: "Canceled",
          result,
          error: null,
        });
        return;
      }
      updateJob(job, {
        status: "done",
        completed: job.total,
        message: "Done",
        result,
      });
    } catch (err) {
      if (err instanceof JobCanceledError || err?.code === "JOB_CANCELED") {
        updateJob(job, {
          status: "canceled",
          message: "Canceled",
          result: err.result ?? null,
          error: null,
        });
        return;
      }
      updateJob(job, {
        status: "error",
        message: "Failed",
        error: err.message || String(err),
      });
    }
  });
}

async function handleJobCreate(req, res) {
  const body = await parseBody(req);
  const operation = String(body.operation || "");
  if (!["copy", "move", "delete"].includes(operation)) badRequest("Unsupported job operation");

  if (operation === "copy" || operation === "move") {
    const plan = await buildTransferPlan(operation, body.sources, body.destination, {
      overwrite: body.overwrite,
      autoRename: body.autoRename,
    });
    const job = createJob(operation, plan.steps.length);
    runJob(job, async ({ progress, isCanceled }) => {
      const results = await executeTransferPlan(plan, {
        isCanceled,
        onProgress: (step) => progress(`${operation}: ${step.to}`),
      });
      return { items: plan.items, results };
    });
    return json(res, 202, { job: serializeJob(job) });
  }

  const plan = await buildDeletePlan(body.paths, Boolean(body.permanent));
  const job = createJob(body.permanent ? "delete" : "trash", plan.steps.length);
  runJob(job, async ({ progress, isCanceled }) => {
    const deleted = await executeDeletePlan(plan, {
      isCanceled,
      onProgress: (step) => progress(`${operation}: ${step.source}`),
    });
    return { deleted };
  });
  json(res, 202, { job: serializeJob(job) });
}

function getJobIdFromPath(pathname) {
  const suffix = pathname.slice("/api/jobs/".length);
  const slash = suffix.indexOf("/");
  return slash >= 0 ? suffix.slice(0, slash) : suffix;
}

async function handleJobGet(req, res, pathname) {
  cleanupJobs();
  const id = getJobIdFromPath(pathname);
  const job = jobs.get(id);
  if (!job) throw new HttpError(404, "Job not found");
  json(res, 200, { job: serializeJob(job) });
}

async function handleJobCancel(req, res, pathname) {
  const id = getJobIdFromPath(pathname);
  const job = jobs.get(id);
  if (!job) throw new HttpError(404, "Job not found");
  if (["done", "error", "canceled"].includes(job.status)) {
    return json(res, 200, { job: serializeJob(job) });
  }
  updateJob(job, {
    cancelRequested: true,
    message: job.status === "queued" ? "Cancel requested" : "Canceling",
  });
  if (job.status === "queued") {
    updateJob(job, { status: "canceled", message: "Canceled" });
  }
  json(res, 202, { job: serializeJob(job) });
}

async function searchEntries(options = {}) {
  const start = normalizeLogical(options.path || USER_ROOT);
  const needle = String(options.q || "").trim().toLowerCase();
  const maxResults = parseBoundedInt(options.limit, 200, 1, 1000, "limit");
  const offset = parseBoundedInt(options.offset, 0, 0, 100000, "offset");
  const maxDepth = parseBoundedInt(options.depth, 8, 0, 20, "depth");
  const type = String(options.type || "any");
  if (!["any", "directory", "file", "symlink", "other"].includes(type)) badRequest("Invalid type filter");
  const minSize = parseBoundedNumber(options.minSize, 0, 0, Number.MAX_SAFE_INTEGER, "minSize");
  const maxSize = parseBoundedNumber(options.maxSize, Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER, "maxSize");
  const mtimeFrom = parseOptionalDateMs(options.mtimeFrom, "mtimeFrom");
  const mtimeTo = parseOptionalDateMs(options.mtimeTo, "mtimeTo");
  if (minSize > maxSize) badRequest("minSize cannot be greater than maxSize");
  if (mtimeFrom && mtimeTo && mtimeFrom > mtimeTo) badRequest("mtimeFrom cannot be after mtimeTo");
  if (!needle) {
    return {
      root: USER_ROOT,
      path: start,
      query: needle,
      filters: { type, minSize, maxSize, mtimeFrom, mtimeTo },
      page: { offset, limit: maxResults, returned: 0, hasMore: false, nextOffset: null },
      stats: { scannedDirectories: 0, collectedMatches: 0, examined: 0, truncated: false },
      results: [],
    };
  }

  const dockerMounts = await getDockerMounts();
  const collected = [];
  const targetCount = offset + maxResults + 1;
  let scannedDirectories = 0;
  let examined = 0;

  function matchesFilters(entry) {
    if (type !== "any" && entry.type !== type) return false;
    if (entry.type === "file" && (entry.size < minSize || entry.size > maxSize)) return false;
    if (mtimeFrom && entry.mtime < mtimeFrom) return false;
    if (mtimeTo && entry.mtime > mtimeTo) return false;
    return true;
  }

  let currentDirs = [start];
  for (let depth = 0; depth <= maxDepth && currentDirs.length && collected.length < targetCount; depth += 1) {
    scannedDirectories += currentDirs.length;
    const batches = await mapConcurrent(currentDirs, SEARCH_DIRECTORY_CONCURRENCY, async (dir) => {
      let dirents = [];
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return { entries: [], childDirs: [] };
      }

      dirents.sort((a, b) => compareNatural(a.name, b.name));
      examined += dirents.length;
      const matchingDirents = [];
      const childDirs = [];
      for (const dirent of dirents) {
        const child = path.join(dir, dirent.name);
        if (dirent.name.toLowerCase().includes(needle)) {
          matchingDirents.push({ child, dirent });
        }
        if (dirent.isDirectory() && depth < maxDepth) {
          childDirs.push(child);
        }
      }

      const matchedEntries = await mapConcurrent(
        matchingDirents,
        SEARCH_MATCH_CONCURRENCY,
        ({ child, dirent }) => makeEntry(child, dirent, dockerMounts)
      );

      return {
        entries: matchedEntries.filter(matchesFilters),
        childDirs,
      };
    });

    const nextDirs = [];
    for (const batch of batches) {
      for (const entry of batch.entries) {
        collected.push(entry);
        if (collected.length >= targetCount) break;
      }
      if (collected.length >= targetCount) break;
      nextDirs.push(...batch.childDirs);
    }
    currentDirs = nextDirs;
  }

  const pageResults = collected.slice(offset, offset + maxResults);
  const hasMore = collected.length > offset + maxResults;
  return {
    root: USER_ROOT,
    path: start,
    query: needle,
    filters: { type, minSize, maxSize, mtimeFrom, mtimeTo },
    page: {
      offset,
      limit: maxResults,
      returned: pageResults.length,
      hasMore,
      nextOffset: hasMore ? offset + pageResults.length : null,
    },
    stats: {
      scannedDirectories,
      collectedMatches: collected.length,
      examined,
      truncated: hasMore,
    },
    results: pageResults,
  };
}

async function handleSearch(req, res, query) {
  const payload = await searchEntries(query);
  json(res, 200, payload);
}

async function handleDisks(req, res) {
  const roots = await getStorageRoots();
  const disks = (await Promise.all(roots.map(async (root) => {
    const st = await statSafe(root);
    if (!st) return null;
    let usage = null;
    if (typeof fsp.statfs === "function") {
      try {
        const sf = await fsp.statfs(root);
        usage = {
          blocks: Number(sf.blocks),
          bfree: Number(sf.bfree),
          bavail: Number(sf.bavail),
          bsize: Number(sf.bsize),
          total: Number(sf.blocks) * Number(sf.bsize),
          free: Number(sf.bavail) * Number(sf.bsize),
          used: (Number(sf.blocks) - Number(sf.bfree)) * Number(sf.bsize),
        };
      } catch {
        usage = null;
      }
    }
    return { name: path.basename(root), path: root, usage };
  }))).filter(Boolean);
  json(res, 200, { roots: disks, userRoot: USER_ROOT, mntRoot: MNT_ROOT });
}

async function handleDocker(req, res) {
  const mounts = await getDockerMounts();
  json(res, 200, { socket: DOCKER_SOCKET, mounts });
}

async function handleDownload(req, res, query) {
  const logicalPath = normalizeLogical(query.path);
  const st = await statSafe(logicalPath);
  if (!st || !st.isFile()) return fail(res, 404, "File not found");
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": st.size,
    "content-disposition": attachmentHeader(path.basename(logicalPath)),
  });
  const stream = fs.createReadStream(logicalPath);
  stream.on("error", (err) => {
    console.error(`[unraid-files] download failed for ${logicalPath}:`, err.message || err);
    if (!res.headersSent) return fail(res, 500, "Download failed");
    res.destroy(err);
  });
  stream.pipe(res);
}

async function handlePreview(req, res, query) {
  const logicalPath = normalizeLogical(query.path);
  const st = await statSafe(logicalPath);
  if (!st || !st.isFile()) return fail(res, 404, "File not found");
  if (!isTextPreviewName(logicalPath)) return fail(res, 415, "Preview is only available for text files");

  const limit = parseBoundedInt(query.limit, MAX_TEXT_PREVIEW_BYTES, 1024, MAX_TEXT_PREVIEW_BYTES, "limit");
  const length = Math.min(st.size, limit);
  const handle = await fsp.open(logicalPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, 0);
    const data = buffer.subarray(0, result.bytesRead);
    if (hasBinaryMarker(data)) return fail(res, 415, "File looks binary and cannot be previewed");
    json(res, 200, {
      path: logicalPath,
      name: path.basename(logicalPath),
      size: st.size,
      limit,
      truncated: st.size > result.bytesRead,
      encoding: "utf-8",
      content: data.toString("utf8"),
    });
  } finally {
    await handle.close();
  }
}

function serveStatic(req, res, pathname, query = {}) {
  const target = pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.resolve(PUBLIC_DIR, "." + pathname);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 403, "Forbidden");
  fs.readFile(target, (err, data) => {
    if (err) return text(res, 404, "Not found");
    const ext = path.extname(target);
    const type =
      ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".css" ? "text/css; charset=utf-8" :
      ext === ".js" ? "application/javascript; charset=utf-8" :
      "application/octet-stream";
    const cacheControl =
      ext === ".html"
        ? "no-store"
        : query.v
        ? "public, max-age=31536000, immutable"
        : "public, max-age=300";
    res.writeHead(200, {
      "content-type": type,
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") return res.end();
    res.end(data);
  });
}

async function route(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";

  try {
    if (!requireAuth(req, res)) return;
    if (req.method === "GET" && pathname === "/api/list") return await listDirectory(req, res, parsed.query);
    if (req.method === "GET" && pathname === "/api/search") return await handleSearch(req, res, parsed.query);
    if (req.method === "GET" && pathname === "/api/disks") return await handleDisks(req, res);
    if (req.method === "GET" && pathname === "/api/docker") return await handleDocker(req, res);
    if (req.method === "GET" && pathname === "/api/trash") return await handleTrashList(req, res);
    if (req.method === "POST" && pathname === "/api/trash/restore") return await handleTrashRestore(req, res);
    if (req.method === "POST" && pathname === "/api/trash/purge") return await handleTrashPurge(req, res);
    if (req.method === "POST" && pathname === "/api/jobs") return await handleJobCreate(req, res);
    if (req.method === "POST" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/cancel")) {
      return await handleJobCancel(req, res, pathname);
    }
    if (req.method === "GET" && pathname.startsWith("/api/jobs/")) return await handleJobGet(req, res, pathname);
    if (req.method === "GET" && pathname === "/api/preview") return await handlePreview(req, res, parsed.query);
    if (req.method === "GET" && pathname === "/api/download") return await handleDownload(req, res, parsed.query);
    if (req.method === "GET" && pathname === "/api/archive") return await handleArchiveDownload(req, res, parsed.query);
    if (req.method === "GET" && pathname === "/api/checksum") return await handleChecksum(req, res, parsed.query);
    if (req.method === "POST" && pathname === "/api/upload") return await handleUpload(req, res, parsed.query);
    if (req.method === "POST" && pathname === "/api/move") return await handleMove(req, res);
    if (req.method === "POST" && pathname === "/api/copy") return await handleCopy(req, res);
    if (req.method === "POST" && pathname === "/api/rename") return await handleRename(req, res);
    if (req.method === "POST" && pathname === "/api/mkdir") return await handleMkdir(req, res);
    if (req.method === "POST" && pathname === "/api/delete") return await handleDelete(req, res);
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, pathname, parsed.query);
    fail(res, 405, "Method not allowed");
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    fail(res, status, err.message || "Internal error", err.details || (process.env.NODE_ENV === "production" ? undefined : String(err.stack || err)));
  }
}

const server = http.createServer(route);

if (require.main === module) {
  server.listen(PORT, () => {
    const id = crypto.randomBytes(3).toString("hex");
    console.log(`[unraid-files ${id}] listening on http://0.0.0.0:${PORT}`);
    console.log(`[unraid-files] user root: ${USER_ROOT}`);
  });
}

module.exports = {
  server,
  normalizeLogical,
  buildTransferPlan,
  executeTransferPlan,
  buildDeletePlan,
  executeDeletePlan,
  cleanupJobs,
  cleanupTrashRefs,
  jobs,
  parseBoundedInt,
  searchEntries,
  runJob,
};
