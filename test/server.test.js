const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.join(os.tmpdir(), `unraid-files-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const mntRoot = path.join(root, "mnt");
const userRoot = path.join(mntRoot, "user");
const disk1 = path.join(mntRoot, "disk1");

process.env.UNRAID_MNT_ROOT = mntRoot;
process.env.UNRAID_USER_ROOT = userRoot;
process.env.UNRAID_REAL_ROOTS = disk1;
process.env.UNRAID_TRASH_DIR = ".trash-test";

const {
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
  server,
} = require("../server");

async function withServer(run) {
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
  });
  try {
    const address = server.address();
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function writeBoth(rel, content) {
  const logical = path.join(userRoot, rel);
  const actual = path.join(disk1, rel);
  await fs.mkdir(path.dirname(logical), { recursive: true });
  await fs.mkdir(path.dirname(actual), { recursive: true });
  await fs.writeFile(logical, content);
  await fs.writeFile(actual, content);
  return { logical, actual };
}

test.beforeEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(userRoot, { recursive: true });
  await fs.mkdir(disk1, { recursive: true });
  jobs.clear();
});

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("copy preflight rejects a later conflict before copying earlier sources", async () => {
  const first = await writeBoth("share/first.txt", "first");
  const second = await writeBoth("share/second.txt", "second");
  await writeBoth("dest/second.txt", "existing");
  await fs.mkdir(path.join(userRoot, "dest"), { recursive: true });

  await assert.rejects(
    buildTransferPlan("copy", [first.logical, second.logical], path.join(userRoot, "dest")),
    /Destination exists/
  );

  await assert.rejects(fs.stat(path.join(disk1, "dest/first.txt")), /ENOENT/);
});

test("copy autoRename chooses an available sibling name", async () => {
  const source = await writeBoth("share/movie.mkv", "movie");
  const plan = await buildTransferPlan("copy", [source.logical], path.join(userRoot, "share"), {
    autoRename: true,
  });

  assert.equal(plan.items[0].destination, path.join(userRoot, "share/movie copy.mkv"));
  await executeTransferPlan(plan);
  assert.equal(await fs.readFile(path.join(disk1, "share/movie copy.mkv"), "utf8"), "movie");
});

test("delete to trash writes a restore manifest", async () => {
  const source = await writeBoth("share/remove.txt", "remove");
  const plan = await buildDeletePlan([source.logical], false);
  await executeDeletePlan(plan);

  const manifest = JSON.parse(
    await fs.readFile(path.join(disk1, ".trash-test", plan.stamp, ".unraid-files-manifest.json"), "utf8")
  );
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].originalLogical, source.logical);
  assert.equal(await fs.readFile(path.join(disk1, ".trash-test", plan.stamp, "share/remove.txt"), "utf8"), "remove");
});

test("cleanupTrashRefs removes manifest entries and empty stamp directories", async () => {
  const source = await writeBoth("share/remove.txt", "remove");
  const plan = await buildDeletePlan([source.logical], false);
  await executeDeletePlan(plan);
  const trashPath = path.join(disk1, ".trash-test", plan.stamp, "share/remove.txt");
  const manifestPath = path.join(disk1, ".trash-test", plan.stamp, ".unraid-files-manifest.json");

  await fs.rm(trashPath, { recursive: true, force: true });
  await cleanupTrashRefs([{ root: disk1, stamp: plan.stamp, trashPath }]);

  await assert.rejects(fs.stat(manifestPath), /ENOENT/);
  await assert.rejects(fs.stat(path.join(disk1, ".trash-test", plan.stamp)), /ENOENT/);
});

test("cleanupJobs removes stale terminal jobs and keeps active jobs", () => {
  jobs.set("old-done", {
    status: "done",
    updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  });
  jobs.set("old-error", {
    status: "error",
    updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  });
  jobs.set("old-canceled", {
    status: "canceled",
    updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  });
  jobs.set("old-running", {
    status: "running",
    updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  });
  jobs.set("fresh-done", {
    status: "done",
    updatedAt: new Date().toISOString(),
  });

  cleanupJobs();

  assert.equal(jobs.has("old-done"), false);
  assert.equal(jobs.has("old-error"), false);
  assert.equal(jobs.has("old-canceled"), false);
  assert.equal(jobs.has("old-running"), true);
  assert.equal(jobs.has("fresh-done"), true);
});

test("parseBoundedInt rejects invalid values", () => {
  assert.equal(parseBoundedInt(undefined, 8, 0, 20, "depth"), 8);
  assert.throws(() => parseBoundedInt("abc", 8, 0, 20, "depth"), /depth must be an integer/);
  assert.throws(() => parseBoundedInt("21", 8, 0, 20, "depth"), /depth must be an integer/);
});

test("searchEntries paginates in stable breadth-first natural order", async () => {
  await fs.mkdir(path.join(userRoot, "share/nested"), { recursive: true });
  await fs.mkdir(path.join(disk1, "share/nested"), { recursive: true });
  await fs.mkdir(path.join(userRoot, "share/server-dir"), { recursive: true });
  await fs.mkdir(path.join(disk1, "share/server-dir"), { recursive: true });
  await writeBoth("share/alpha-server.txt", "alpha");
  await writeBoth("share/nested/server-two.txt", "two");

  const data = await searchEntries({
    path: path.join(userRoot, "share"),
    q: "server",
    limit: 1,
    offset: 1,
    depth: 3,
  });

  assert.equal(data.page.offset, 1);
  assert.equal(data.page.limit, 1);
  assert.equal(data.page.returned, 1);
  assert.equal(data.page.hasMore, true);
  assert.equal(data.page.nextOffset, 2);
  assert.equal(data.stats.truncated, true);
  assert.deepEqual(data.results.map((entry) => entry.relativePath), ["share/server-dir"]);
});

test("searchEntries returns metadata for an empty query without scanning", async () => {
  const data = await searchEntries({
    path: path.join(userRoot, "share"),
    q: "   ",
    limit: 5,
  });

  assert.equal(data.page.returned, 0);
  assert.equal(data.page.hasMore, false);
  assert.equal(data.stats.scannedDirectories, 0);
  assert.deepEqual(data.results, []);
});

test("versioned static assets use immutable caching", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/app.js?v=test-cache`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });
});

test("html responses stay uncacheable", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(baseUrl);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });
});

test("job cancel endpoint marks queued jobs as canceled", async () => {
  jobs.set("queued-job", {
    id: "queued-job",
    operation: "copy",
    status: "queued",
    total: 2,
    completed: 0,
    message: "Queued",
    result: null,
    error: null,
    cancelRequested: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await withServer(async (baseUrl) => {
    const cancelRes = await fetch(`${baseUrl}/api/jobs/queued-job/cancel`, { method: "POST" });
    assert.equal(cancelRes.status, 202);
    const cancelPayload = await cancelRes.json();
    assert.equal(cancelPayload.job.status, "canceled");
    assert.equal(cancelPayload.job.cancelRequested, true);

    const statusRes = await fetch(`${baseUrl}/api/jobs/queued-job`);
    assert.equal(statusRes.status, 200);
    const statusPayload = await statusRes.json();
    assert.equal(statusPayload.job.status, "canceled");
  });
});

test("runJob preserves partial result when cancellation is requested mid-run", async () => {
  const job = {
    id: "running-job",
    operation: "copy",
    status: "queued",
    total: 3,
    completed: 0,
    message: "Queued",
    result: null,
    error: null,
    cancelRequested: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);

  let observedRunning = false;
  runJob(job, async ({ progress, isCanceled }) => {
    progress("copy: one");
    observedRunning = true;
    while (!isCanceled()) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { partial: true, completed: 1 };
  });

  await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (observedRunning && job.status === "running") {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > 1000) {
        clearInterval(timer);
        reject(new Error("Job did not start running in time"));
      }
    }, 5);
  });

  job.cancelRequested = true;

  await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (job.status === "canceled") {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > 1000) {
        clearInterval(timer);
        reject(new Error("Job did not cancel in time"));
      }
    }, 5);
  });

  assert.equal(job.completed, 1);
  assert.equal(job.status, "canceled");
  assert.equal(job.message, "Canceled");
  assert.deepEqual(job.result, { partial: true, completed: 1 });
  assert.equal(job.error, null);
});
