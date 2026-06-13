const state = {
  root: "/mnt/user",
  path: "/mnt/user",
  parent: "",
  entries: [],
  trashEntries: [],
  view: "files",
  displayMode: "list",
  selected: new Set(),
  focused: null,
  selectionAnchor: null,
  disks: [],
  dockerMounts: [],
  favorites: [],
  previewToken: 0,
  sort: { key: "name", dir: "asc" },
  search: {
    active: false,
    query: "",
    page: null,
    stats: null,
  },
};

const previewExtensions = new Set([
  "bash", "c", "cfg", "conf", "cpp", "cs", "css", "csv", "dart", "env", "fish",
  "go", "h", "hpp", "htm", "html", "ini", "java", "js", "json", "jsx", "kt",
  "kts", "log", "lua", "md", "mjs", "php", "pl", "properties", "py", "rb",
  "rs", "scss", "sh", "sql", "svg", "svelte", "toml", "ts", "tsx", "tsv",
  "txt", "vue", "xml", "yaml", "yml", "zsh",
]);

const previewNames = new Set([".dockerignore", ".env", ".gitignore", "dockerfile", "makefile", "readme"]);
const imageExtensions = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);
const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const SEARCH_DEBOUNCE_MS = 250;
const compactViewport = window.matchMedia("(max-width: 900px)");
const searchRequest = {
  token: 0,
  controller: null,
  debounceTimer: null,
};

const $ = (id) => document.getElementById(id);

const els = {
  sidebar: $("sidebar"),
  sidebarToggle: $("sidebarToggle"),
  sidebarBackdrop: $("sidebarBackdrop"),
  rootLabel: $("rootLabel"),
  homeSource: $("homeSource"),
  trashSource: $("trashSource"),
  favoriteList: $("favoriteList"),
  searchInput: $("searchInput"),
  searchButton: $("searchButton"),
  searchSummary: $("searchSummary"),
  searchSummaryTitle: $("searchSummaryTitle"),
  searchSummaryMeta: $("searchSummaryMeta"),
  searchLoadMore: $("searchLoadMore"),
  searchClear: $("searchClear"),
  directoryNavUp: $("directoryNavUp"),
  directoryBreadcrumbs: $("directoryBreadcrumbs"),
  listViewButton: $("listViewButton"),
  iconViewButton: $("iconViewButton"),
  fileTable: $("fileTable"),
  fileRows: $("fileRows"),
  fileGrid: $("fileGrid"),
  emptyState: $("emptyState"),
  viewLoading: $("viewLoading"),
  viewLoadingText: $("viewLoadingText"),
  content: document.querySelector(".content"),
  tableWrap: document.querySelector(".table-wrap"),
  detailsHead: $("detailsHead"),
  details: $("details"),
  detailBody: $("detailBody"),
  diskList: $("diskList"),
  refreshDisks: $("refreshDisks"),
  dockerList: $("dockerList"),
  refreshDocker: $("refreshDocker"),
  promptDialog: $("promptDialog"),
  promptTitle: $("promptTitle"),
  promptLabel: $("promptLabel"),
  promptInput: $("promptInput"),
  directoryDialog: $("directoryDialog"),
  directoryTitle: $("directoryTitle"),
  directoryUp: $("directoryUp"),
  directoryPath: $("directoryPath"),
  directoryList: $("directoryList"),
  directoryEmpty: $("directoryEmpty"),
  directoryChoose: $("directoryChoose"),
  contextMenu: $("contextMenu"),
  toastStack: $("toastStack"),
  uploadInput: $("uploadInput"),
};

function api(path, options = {}) {
  return fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  }).then(async (res) => {
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text };
      }
    }
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  });
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "-";
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = value;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size.toFixed(size >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function formatMode(value) {
  return Number.isInteger(value) ? value.toString(8).padStart(4, "0") : "-";
}

function formatDiskLabel(value, fallback = "logical") {
  return String(value || fallback).trim().replace(/[,\s]+$/g, "") || fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pathDirname(value) {
  const normalized = String(value || "").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.slice(0, idx) : "/";
}

function compareNatural(a, b) {
  return naturalCollator.compare(String(a), String(b));
}

async function copyText(text, successMessage = "已复制") {
  const value = String(text ?? "");
  if (!value) return false;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    showToast(successMessage, "success");
    return true;
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("复制失败");
  showToast(successMessage, "success");
  return true;
}

function clearSearchDebounce() {
  if (!searchRequest.debounceTimer) return;
  clearTimeout(searchRequest.debounceTimer);
  searchRequest.debounceTimer = null;
}

function cancelPendingSearchRequest() {
  searchRequest.token += 1;
  if (!searchRequest.controller) return;
  searchRequest.controller.abort();
  searchRequest.controller = null;
}

function isAbortError(err) {
  return err?.name === "AbortError";
}

function resetSearchState() {
  state.search = {
    active: false,
    query: "",
    page: null,
    stats: null,
  };
}

function currentSearchOptions(offset = 0) {
  const params = new URLSearchParams({
    path: state.path,
    q: els.searchInput.value.trim(),
    offset: String(offset),
  });
  return params;
}

function setViewLoading(loading, message = "正在读取...") {
  els.viewLoading.hidden = !loading;
  els.viewLoadingText.textContent = message;
  els.tableWrap.classList.toggle("is-loading", loading);
  els.tableWrap.setAttribute("aria-busy", String(Boolean(loading)));
}

function renderEmptyState() {
  const isEmpty = state.view === "trash" ? state.trashEntries.length === 0 : state.entries.length === 0;
  els.emptyState.hidden = !isEmpty;
  if (!isEmpty) return;

  let title = "当前目录没有内容";
  let message = "可以新建文件夹，或从其他位置复制内容到这里。";
  let action = "新建文件夹";
  let actionId = "emptyPrimary";

  if (state.view === "trash") {
    title = "回收区是空的";
    message = "移入回收区的文件会显示在这里，并可在清除前恢复。";
    action = "返回用户共享";
  } else if (state.search.active) {
    title = "没有找到匹配项";
    message = "尝试调整搜索关键词。";
    action = "清除搜索";
  }

  els.emptyState.innerHTML = `
    <div class="empty-card">
      <span class="empty-eyebrow">${state.view === "trash" ? "回收区" : state.search.active ? "搜索结果" : "空目录"}</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(message)}</p>
      <button class="tool-button primary-tool" id="${actionId}" type="button">${escapeHtml(action)}</button>
    </div>
  `;

  document.getElementById(actionId).onclick = () => {
    if (state.view === "trash") loadPath(state.root);
    else if (state.search.active) {
      els.searchInput.value = "";
      loadPath(state.path);
    } else createFolderAction();
  };
}

function loadFavorites() {
  try {
    const parsed = JSON.parse(localStorage.getItem("unraid-files:favorites") || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function saveFavorites() {
  localStorage.setItem("unraid-files:favorites", JSON.stringify(state.favorites));
}

function loadDisplayMode() {
  try {
    const value = localStorage.getItem("unraid-files:display-mode");
    if (value === "list" || value === "cards") return value;
  } catch {
    // Ignore localStorage access failures and fall back to viewport heuristics.
  }
  return window.matchMedia("(max-width: 720px)").matches ? "cards" : "list";
}

function saveDisplayMode() {
  try {
    localStorage.setItem("unraid-files:display-mode", state.displayMode);
  } catch {
    // Ignore localStorage access failures.
  }
}

function isCompactViewport() {
  return compactViewport.matches;
}

function setSidebarOpen(open) {
  const visible = Boolean(open) && isCompactViewport();
  document.body.classList.toggle("sidebar-open", visible);
  els.sidebarBackdrop.hidden = !visible;
  els.sidebarToggle.setAttribute("aria-expanded", String(visible));
  els.sidebarToggle.title = visible ? "隐藏侧栏" : "显示侧栏";
  els.sidebarToggle.setAttribute("aria-label", els.sidebarToggle.title);
}

function closeSidebarIfCompact() {
  if (isCompactViewport()) setSidebarOpen(false);
}

function syncResponsiveLayout() {
  if (!isCompactViewport()) setSidebarOpen(false);
}

function renderFavorites() {
  els.favoriteList.innerHTML = "";
  for (const favorite of state.favorites) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "favorite-item";
    button.title = favorite;
    button.innerHTML = `
      <span class="source-icon">F</span>
      <span>${escapeHtml(favorite === state.root ? "用户共享" : favorite.replace(`${state.root}/`, ""))}</span>
    `;
    button.onclick = () => loadPath(favorite);
    els.favoriteList.append(button);
  }
}

function isPreviewable(entry) {
  if (!entry || entry.type !== "file") return false;
  return previewNames.has(entry.name.toLowerCase()) || previewExtensions.has(entry.extension);
}

function isImagePreviewable(entry) {
  return Boolean(entry && entry.type === "file" && imageExtensions.has(entry.extension));
}

function selectedEntries() {
  return state.entries.filter((entry) => state.selected.has(entry.path));
}

function selectedTrashEntries() {
  return state.trashEntries.filter((entry) => state.selected.has(entry.id));
}

function activeEntries() {
  if (state.view === "trash") return selectedTrashEntries();
  const selected = selectedEntries();
  return selected.length ? selected : state.focused && state.focused.path !== state.path ? [state.focused] : [];
}

function formatOwner(entry) {
  if (!entry) return "-";
  const owner = entry.owner || entry.uid;
  const group = entry.group || entry.gid;
  if (owner === null || owner === undefined || owner === "") return "-";
  return `${owner}:${group === null || group === undefined || group === "" ? "-" : group}`;
}

function sortValue(entry, key) {
  if (key === "size") return entry.type === "directory" ? -1 : Number(entry.size || 0);
  if (key === "mtime") return Number(entry.mtime || 0);
  if (key === "owner") return formatOwner(entry);
  if (key === "disk") return entry.disk || "logical";
  return entry.name || "";
}

function compareValues(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return compareNatural(a, b);
}

function sortedEntries() {
  const entries = [...state.entries];
  entries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    const result = compareValues(sortValue(a, state.sort.key), sortValue(b, state.sort.key));
    return state.sort.dir === "asc" ? result : -result;
  });
  return entries;
}

function setDisplayMode(mode) {
  if (!["list", "cards"].includes(mode) || state.displayMode === mode) return;
  state.displayMode = mode;
  saveDisplayMode();
  renderDisplayMode();
  renderRows();
  updateSelection();
}

function renderDisplayMode() {
  const isCards = state.displayMode === "cards";
  els.fileTable.hidden = isCards;
  els.fileGrid.hidden = !isCards;
  els.tableWrap.classList.toggle("cards-mode", isCards);
  els.detailsHead.hidden = isCards;
  els.details.classList.toggle("cards-mode", isCards);
  els.listViewButton.classList.toggle("active", !isCards);
  els.iconViewButton.classList.toggle("active", isCards);
  els.listViewButton.setAttribute("aria-pressed", String(!isCards));
  els.iconViewButton.setAttribute("aria-pressed", String(isCards));
}

function renderSortButtons() {
  document.querySelectorAll(".sort-button").forEach((button) => {
    const active = button.dataset.sort === state.sort.key;
    button.classList.toggle("active", active);
    button.classList.toggle("asc", active && state.sort.dir === "asc");
    button.classList.toggle("desc", active && state.sort.dir === "desc");
    button.setAttribute("aria-sort", active ? (state.sort.dir === "asc" ? "ascending" : "descending") : "none");
  });
}

function updateSelection() {
  return state.selected.size;
}

function renderDirectoryNavigation() {
  els.directoryBreadcrumbs.innerHTML = "";
  const inTrash = state.view === "trash";
  els.directoryNavUp.disabled = inTrash || !state.parent;

  if (inTrash) {
    const current = document.createElement("span");
    current.className = "directory-crumb current";
    current.textContent = "回收区";
    els.directoryBreadcrumbs.append(current);
    return;
  }

  const root = document.createElement("button");
  root.type = "button";
  root.className = `directory-crumb${state.path === state.root ? " current" : ""}`;
  root.textContent = "用户共享";
  root.disabled = state.path === state.root;
  root.onclick = () => loadPath(state.root);
  els.directoryBreadcrumbs.append(root);

  const relative = state.path === state.root ? "" : state.path.slice(state.root.length).replace(/^\/+/, "");
  let currentPath = state.root;
  for (const part of relative.split("/").filter(Boolean)) {
    const separator = document.createElement("span");
    separator.className = "directory-separator";
    separator.textContent = "/";
    els.directoryBreadcrumbs.append(separator);

    currentPath = `${currentPath.replace(/\/$/, "")}/${part}`;
    const target = currentPath;
    const crumb = document.createElement("button");
    crumb.type = "button";
    crumb.className = `directory-crumb${target === state.path ? " current" : ""}`;
    crumb.textContent = part;
    crumb.disabled = target === state.path;
    crumb.onclick = () => loadPath(target);
    els.directoryBreadcrumbs.append(crumb);
  }
}

function iconFor(entry) {
  if (entry.type === "directory") return "";
  if (entry.type === "symlink") return "LNK";
  return entry.extension ? entry.extension.slice(0, 4).toUpperCase() : "DOC";
}

function clearDisplayContainers() {
  els.fileRows.innerHTML = "";
  els.fileGrid.innerHTML = "";
}

function resetContentScroll() {
  els.content.scrollTop = 0;
}

function entryKey(entry) {
  return state.view === "trash" ? entry.id : entry.path;
}

function visibleEntries() {
  return state.view === "trash" ? state.trashEntries : sortedEntries();
}

function renderSelectionState() {
  document.querySelectorAll(".file-row[data-entry-key], .file-card[data-entry-key]").forEach((element) => {
    element.classList.toggle("active", state.selected.has(element.dataset.entryKey));
  });
}

function selectEntry(event, entry) {
  const key = entryKey(entry);
  const additive = event.ctrlKey || event.metaKey;
  if (event.shiftKey && state.selectionAnchor) {
    const entries = visibleEntries();
    const start = entries.findIndex((item) => entryKey(item) === state.selectionAnchor);
    const end = entries.findIndex((item) => entryKey(item) === key);
    if (start >= 0 && end >= 0) {
      if (!additive) state.selected.clear();
      for (const item of entries.slice(Math.min(start, end), Math.max(start, end) + 1)) {
        state.selected.add(entryKey(item));
      }
    }
  } else if (additive) {
    if (state.selected.has(key)) state.selected.delete(key);
    else state.selected.add(key);
    state.selectionAnchor = key;
  } else {
    state.selected.clear();
    state.selected.add(key);
    state.selectionAnchor = key;
  }
  state.focused = state.selected.has(key)
    ? entry
    : visibleEntries().find((item) => state.selected.has(entryKey(item))) || null;
  renderSelectionState();
  renderDetails();
  updateSelection();
}

function focusEntryForContext(key, entry) {
  if (!state.selected.has(key)) {
    state.selected.clear();
    state.selected.add(key);
    state.selectionAnchor = key;
  }
  state.focused = entry;
  renderSelectionState();
  renderDetails();
  updateSelection();
}

function setAllSelection(checked) {
  state.selected.clear();
  if (checked) {
    const rows = state.view === "trash" ? state.trashEntries : state.entries;
    for (const entry of rows) state.selected.add(state.view === "trash" ? entry.id : entry.path);
  }
  state.selectionAnchor = null;
  renderSelectionState();
  renderDetails();
  updateSelection();
}

function renderTrashCards() {
  renderEmptyState();
  renderSortButtons();

  for (const entry of state.trashEntries) {
    const card = document.createElement("article");
    card.className = `file-card trash-card${state.selected.has(entry.id) ? " active" : ""}`;
    card.dataset.entryKey = entry.id;
    const iconClass =
      entry.type === "directory" ? "dir" :
      entry.type === "symlink" ? "link" :
      "file";
    const name = entry.name || entry.originalLogical.split("/").pop() || entry.originalLogical;

    card.innerHTML = `
      <span class="file-icon ${iconClass}">${escapeHtml(iconFor(entry))}</span>
      <strong class="card-name" title="${escapeHtml(name)}">${escapeHtml(name)}</strong>
      <span class="card-subtitle">${escapeHtml(entry.disk || "logical")}</span>
    `;

    card.onclick = (event) => selectEntry(event, entry);
    card.oncontextmenu = (event) => {
      event.preventDefault();
      focusEntryForContext(entry.id, entry);
      showContextMenu(event.clientX, event.clientY, "trash");
    };
    els.fileGrid.append(card);
  }
}

function renderTrashRows() {
  clearDisplayContainers();
  renderEmptyState();
  renderSortButtons();

  if (state.displayMode === "cards") {
    renderTrashCards();
    return;
  }

  for (const entry of state.trashEntries) {
    const tr = document.createElement("tr");
    tr.className = `file-row${state.selected.has(entry.id) ? " active" : ""}`;
    tr.dataset.entryKey = entry.id;
    tr.onclick = (event) => selectEntry(event, entry);
    tr.oncontextmenu = (event) => {
      event.preventDefault();
      focusEntryForContext(entry.id, entry);
      showContextMenu(event.clientX, event.clientY, "trash");
    };

    const iconClass =
      entry.type === "directory" ? "dir" :
      entry.type === "symlink" ? "link" :
      "file";
    const name = entry.name || entry.originalLogical.split("/").pop() || entry.originalLogical;
    const owner = formatOwner(entry);
    tr.innerHTML = `
      <td>
        <div class="name-cell">
          <span class="file-icon ${iconClass}">${escapeHtml(iconFor(entry))}</span>
          <span class="file-name" title="${escapeHtml(entry.originalLogical)}">
            ${escapeHtml(name)}
            <span class="sub-name">${escapeHtml(entry.originalLogical)}</span>
          </span>
        </div>
      </td>
      <td>${entry.type === "directory" ? "-" : escapeHtml(formatBytes(entry.size))}</td>
      <td>${escapeHtml(formatDate(Date.parse(entry.deletedAt) || entry.mtime))}</td>
      <td><span class="owner-value">${escapeHtml(owner)}</span></td>
      <td><span class="disk-value" title="${escapeHtml(formatDiskLabel(entry.disk))}">${escapeHtml(formatDiskLabel(entry.disk))}</span></td>
    `;

    els.fileRows.append(tr);
  }
}

function renderFileCards() {
  renderEmptyState();
  renderSortButtons();

  for (const entry of sortedEntries()) {
    const card = document.createElement("article");
    card.className = `file-card${state.selected.has(entry.path) ? " active" : ""}`;
    card.dataset.entryKey = entry.path;
    const iconClass =
      entry.type === "directory" ? "dir" :
      entry.type === "symlink" ? "link" :
      "file";
    card.innerHTML = `
      <span class="file-icon ${iconClass}">${escapeHtml(iconFor(entry))}</span>
      <strong class="card-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</strong>
    `;

    card.onclick = (event) => selectEntry(event, entry);
    card.ondblclick = () => {
      if (entry.type === "directory") loadPath(entry.path);
    };
    card.oncontextmenu = (event) => {
      event.preventDefault();
      focusEntryForContext(entry.path, entry);
      showContextMenu(event.clientX, event.clientY, "entry");
    };
    els.fileGrid.append(card);
  }
}

function renderRows() {
  clearDisplayContainers();
  renderDisplayMode();
  if (state.view === "trash") {
    renderTrashRows();
    return;
  }
  renderEmptyState();

  renderSortButtons();

  if (state.displayMode === "cards") {
    renderFileCards();
    return;
  }

  for (const entry of sortedEntries()) {
    const tr = document.createElement("tr");
    tr.className = `file-row${state.selected.has(entry.path) ? " active" : ""}`;
    tr.dataset.entryKey = entry.path;
    tr.onclick = (event) => selectEntry(event, entry);
    tr.oncontextmenu = (event) => {
      event.preventDefault();
      focusEntryForContext(entry.path, entry);
      showContextMenu(event.clientX, event.clientY, "entry");
    };

    const nameControl = `<span class="file-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>`;
    const iconClass =
      entry.type === "directory" ? "dir" :
      entry.type === "symlink" ? "link" :
      "file";
    const diskLabel = formatDiskLabel(entry.disk);
    const owner = formatOwner(entry);

    tr.innerHTML = `
      <td>
        <div class="name-cell">
          <span class="file-icon ${iconClass}">${escapeHtml(iconFor(entry))}</span>
          ${nameControl}
        </div>
      </td>
      <td>${entry.type === "directory" ? "-" : escapeHtml(formatBytes(entry.size))}</td>
      <td>${escapeHtml(formatDate(entry.mtime))}</td>
      <td><span class="owner-value">${escapeHtml(owner)}</span></td>
      <td><span class="disk-value" title="${escapeHtml(diskLabel)}">${escapeHtml(diskLabel)}</span></td>
    `;

    tr.ondblclick = () => {
      if (entry.type === "directory") loadPath(entry.path);
    };

    els.fileRows.append(tr);
  }
}

function block(title, html) {
  return `<section class="detail-block"><h3 class="detail-title">${escapeHtml(title)}</h3>${html}</section>`;
}

function kv(rows) {
  return `<dl class="kv">${rows
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`)
    .join("")}</dl>`;
}

function renderDetails() {
  if (state.view === "trash") {
    const entry = state.focused || state.trashEntries[0] || null;
    if (!entry) {
      els.detailBody.innerHTML = block("回收区", `<p class="muted">没有可显示的项目。</p>`);
      return;
    }
    els.detailBody.innerHTML =
      block(
        "回收区项目",
        kv([
          ["名称", escapeHtml(entry.name || "-")],
          ["原逻辑路径", escapeHtml(entry.originalLogical || "-")],
          ["原实际路径", escapeHtml(entry.originalActual || "-")],
          ["回收区路径", escapeHtml(entry.trashPath || "-")],
          ["所在磁盘", escapeHtml(entry.disk || "-")],
          ["类型", escapeHtml(entry.type || "-")],
          ["删除时间", escapeHtml(formatDate(Date.parse(entry.deletedAt) || entry.mtime))],
        ])
      );
    return;
  }

  const entry = state.focused || {
    name: state.path.split("/").pop() || state.path,
    path: state.path,
    type: "directory",
    size: 0,
    disk: "",
    locations: [],
    dockerMounts: [],
  };

  const locations = entry.locations?.length
    ? entry.locations
        .map((loc) =>
          block(
            loc.disk,
            kv([
              ["类型", escapeHtml(loc.type)],
              ["实际路径", escapeHtml(loc.path)],
              ["大小", escapeHtml(formatBytes(loc.size))],
            ])
          )
        )
        .join("")
    : block("实际位置", `<p class="muted">未在 disk/cache/pool 下找到对应实体，可能是纯逻辑路径或权限不足。</p>`);

  const mounts = entry.dockerMounts?.length
    ? entry.dockerMounts
        .map((mount) =>
          block(
            mount.container,
            kv([
              ["镜像", escapeHtml(mount.image || "-")],
              ["状态", escapeHtml(mount.state || "-")],
              ["源路径", escapeHtml(mount.source)],
              ["容器路径", escapeHtml(mount.destination)],
              ["权限", escapeHtml(mount.rw ? "读写" : "只读")],
            ])
          )
        )
        .join("")
    : block("Docker 挂载", `<p class="muted">没有匹配的容器挂载。</p>`);

  let preview = "";
  if (isImagePreviewable(entry)) {
    const src = `/api/download?path=${encodeURIComponent(entry.path)}`;
    preview = block(
      "图片预览",
      `<div class="image-preview-wrap"><img class="image-preview" src="${src}" alt="${escapeHtml(entry.name)}" loading="lazy" /></div>`
    );
  } else if (isPreviewable(entry)) {
    preview = block(
      "文本预览",
      `<div class="preview-meta" id="previewMeta">正在读取...</div><pre class="text-preview" id="previewBody">加载中</pre>`
    );
  } else if (entry.type === "file") {
    preview = block("预览", `<p class="muted">此文件类型暂不支持文本预览。</p>`);
  }

  const actions = [];
  if (entry.path) {
    actions.push(`<button class="tool-button" id="detailCopyPath" type="button">复制路径</button>`);
  }
  if (entry.type === "directory" && entry.path && entry.path !== state.path) {
    actions.push(`<button class="tool-button" id="detailOpen" type="button">打开目录</button>`);
  }
  if (entry.type === "file") {
    actions.push(`<button class="tool-button" id="detailDownload" type="button">下载文件</button>`);
    actions.push(`<button class="tool-button" id="detailChecksum" type="button">计算 SHA-256</button>`);
  }
  const actionBlock = actions.length
    ? block("快捷操作", `<div class="detail-actions">${actions.join("")}</div>`)
    : "";

  els.detailBody.innerHTML =
    block(
      "当前项",
      kv([
        ["名称", escapeHtml(entry.name)],
        ["逻辑路径", escapeHtml(entry.path)],
        ["类型", escapeHtml(entry.type)],
        ["所在磁盘", escapeHtml(entry.disk || "-")],
        ["权限", escapeHtml(formatMode(entry.mode))],
        ["所有者", escapeHtml(formatOwner(entry))],
        ["UID:GID", escapeHtml(entry.uid === null || entry.uid === undefined ? "-" : `${entry.uid}:${entry.gid ?? "-"}`)],
        ["修改时间", escapeHtml(formatDate(entry.mtime))],
      ])
    ) + actionBlock + preview + locations + mounts;

  const copyPathButton = document.getElementById("detailCopyPath");
  if (copyPathButton) {
    copyPathButton.onclick = () => {
      copyText(entry.path, "已复制逻辑路径").catch((err) => showToast(err.message || String(err), "error", 5200));
    };
  }
  const openButton = document.getElementById("detailOpen");
  if (openButton) openButton.onclick = () => loadPath(entry.path);
  const downloadButton = document.getElementById("detailDownload");
  if (downloadButton) downloadButton.onclick = downloadAction;
  const checksumButton = document.getElementById("detailChecksum");
  if (checksumButton) {
    checksumButton.onclick = () => {
      runAction(async () => {
        const data = await api(`/api/checksum?path=${encodeURIComponent(entry.path)}`);
        await copyText(data.checksum, "SHA-256 已复制");
        return true;
      }, { pending: "正在计算 SHA-256..." });
    };
  }

  if (!isImagePreviewable(entry) && isPreviewable(entry)) loadPreview(entry);
}

function showToast(message, type = "info", timeout = 3200) {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  els.toastStack.append(item);
  if (timeout) {
    setTimeout(() => item.remove(), timeout);
  }
  return item;
}

function createProgressToast(message, cancelLabel, onCancel) {
  const item = document.createElement("div");
  item.className = "toast busy progress-toast";
  const text = document.createElement("div");
  text.className = "toast-message";
  text.textContent = message;
  item.append(text);

  let button = null;
  if (cancelLabel && onCancel) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = cancelLabel;
    button.onclick = () => onCancel(button);
    item.append(button);
  }

  els.toastStack.append(item);
  return {
    item,
    setMessage(next) {
      text.textContent = next;
    },
    setCancelState(label, disabled = false) {
      if (!button) return;
      button.textContent = label;
      button.disabled = disabled;
    },
    remove() {
      item.remove();
    },
  };
}

function hideContextMenu() {
  els.contextMenu.hidden = true;
  els.contextMenu.innerHTML = "";
}

function menuButton(label, action, disabled = false) {
  return `<button type="button" data-action="${action}" ${disabled ? "disabled" : ""}>${escapeHtml(label)}</button>`;
}

function showContextMenu(x, y, mode) {
  const selected = activeEntries();
  const single = selected.length === 1 ? selected[0] : null;
  const canDownload = selected.length > 0;
  const items = mode === "trash"
    ? [
        menuButton("恢复", "restore", !selected.length),
        menuButton("清除", "purge", !selected.length),
      ]
    : mode === "blank"
    ? [
        menuButton("返回上一级", "up", !state.parent),
        menuButton(state.favorites.includes(state.path) ? "取消收藏当前目录" : "收藏当前目录", "favorite"),
        menuButton("新建文件夹", "mkdir"),
        menuButton("上传文件", "upload"),
        `<hr />`,
        menuButton("全选", "selectAll", !state.entries.length),
        menuButton(state.displayMode === "cards" ? "切换到列表视图" : "切换到卡片视图", "toggleView"),
        menuButton("刷新", "refresh"),
      ]
    : [
        menuButton("打开", "open", !single || single.type !== "directory"),
        menuButton("重命名", "rename", selected.length !== 1),
        menuButton("移动", "move", !selected.length),
        menuButton("复制", "copy", !selected.length),
        menuButton(selected.length === 1 && single?.type === "file" ? "下载" : "打包下载", "download", !canDownload),
        `<hr />`,
        menuButton("新建文件夹", "mkdir"),
        menuButton("上传文件", "upload"),
        `<hr />`,
        menuButton("移入回收区", "trash", !selected.length),
        menuButton("永久删除", "delete", !selected.length),
      ];

  els.contextMenu.innerHTML = items.join("");
  els.contextMenu.hidden = false;
  const rect = els.contextMenu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  els.contextMenu.style.left = `${Math.max(8, left)}px`;
  els.contextMenu.style.top = `${Math.max(8, top)}px`;
}

function dispatchContextAction(action) {
  switch (action) {
    case "open":
      openAction();
      break;
    case "rename":
      renameAction();
      break;
    case "move":
      moveAction();
      break;
    case "copy":
      copyAction();
      break;
    case "download":
      downloadAction();
      break;
    case "trash":
      trashAction();
      break;
    case "delete":
      deleteAction();
      break;
    case "mkdir":
      createFolderAction();
      break;
    case "upload":
      uploadAction();
      break;
    case "refresh":
      hideContextMenu();
      loadPath(state.path);
      break;
    case "favorite":
      toggleFavoriteAction();
      break;
    case "up":
      hideContextMenu();
      if (state.view === "files" && state.parent) loadPath(state.parent);
      break;
    case "selectAll":
      hideContextMenu();
      setAllSelection(true);
      break;
    case "toggleView":
      hideContextMenu();
      setDisplayMode(state.displayMode === "cards" ? "list" : "cards");
      break;
    case "restore":
      restoreAction();
      break;
    case "purge":
      purgeAction();
      break;
  }
}

async function runAction(fn, messages = {}) {
  let pending = null;
  try {
    hideContextMenu();
    if (messages.pending) pending = showToast(messages.pending, "busy", 0);
    const result = await fn();
    if (pending) pending.remove();
    if (messages.success && result !== false) showToast(messages.success, "success");
    return result;
  } catch (err) {
    if (pending) pending.remove();
    showToast(err.message || String(err), "error", 5200);
  }
}

async function loadPreview(entry) {
  const token = ++state.previewToken;
  try {
    const data = await api(`/api/preview?path=${encodeURIComponent(entry.path)}`);
    if (token !== state.previewToken || state.focused?.path !== entry.path) return;
    const meta = document.getElementById("previewMeta");
    const body = document.getElementById("previewBody");
    if (!meta || !body) return;
    meta.textContent = `${formatBytes(data.size)}${data.truncated ? `，仅显示前 ${formatBytes(data.limit)}` : ""}`;
    body.textContent = data.content || "文件为空";
  } catch (err) {
    if (token !== state.previewToken || state.focused?.path !== entry.path) return;
    const meta = document.getElementById("previewMeta");
    const body = document.getElementById("previewBody");
    if (meta) meta.textContent = "无法预览";
    if (body) body.textContent = err.message || String(err);
  }
}

function renderDisks() {
  const countEl = $("diskCount");
  if (countEl) countEl.textContent = state.disks.length || "";
  els.diskList.innerHTML = state.disks.length ? "" : `<div class="empty-note">未发现磁盘根目录</div>`;
  for (const disk of state.disks) {
    const total = disk.usage?.total || 0;
    const used = disk.usage?.used || 0;
    const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
    const free = total ? Math.max(0, total - used) : 0;
    const item = document.createElement("div");
    item.className = "disk-item";
    item.innerHTML = `
      <div class="disk-top">
        <span class="disk-name">${escapeHtml(disk.name)}</span>
        <span class="disk-free">${total ? `${formatBytes(free)} 可用` : "容量未知"}</span>
      </div>
      <div class="usage"><span style="width: ${pct}%"></span></div>
      <div class="disk-meta">${escapeHtml(disk.path)}</div>
    `;
    els.diskList.append(item);
  }
}

function renderSearchSummary() {
  if (!state.search.active) {
    els.searchSummary.hidden = true;
    els.searchLoadMore.hidden = true;
    els.searchClear.hidden = true;
    els.searchSummaryTitle.textContent = "搜索结果";
    els.searchSummaryMeta.textContent = "";
    return;
  }

  const page = state.search.page || { returned: state.entries.length, hasMore: false };
  const stats = state.search.stats || { scannedDirectories: 0, collectedMatches: state.entries.length, examined: 0 };
  els.searchSummary.hidden = false;
  els.searchLoadMore.hidden = !page.hasMore;
  els.searchLoadMore.disabled = false;
  els.searchClear.hidden = false;
  els.searchSummaryTitle.textContent = `搜索: ${state.search.query || "-"}`;
  els.searchSummaryMeta.textContent =
    `已显示 ${state.entries.length} 项，当前页 ${page.returned} 项，` +
    `已扫描 ${stats.scannedDirectories} 个目录 / 检查 ${stats.examined} 个名称 / 收集 ${stats.collectedMatches} 个匹配`;
}

async function loadPath(path) {
  clearSearchDebounce();
  cancelPendingSearchRequest();
  setViewLoading(true, "正在读取目录...");
  try {
    const data = await api(`/api/list?path=${encodeURIComponent(path)}`);
    resetSearchState();
    state.view = "files";
    state.root = data.root;
    state.path = data.path;
    state.parent = data.parent;
    state.entries = data.entries;
    state.selected.clear();
    state.selectionAnchor = null;
    state.focused = data.current;
    els.homeSource.classList.add("active");
    els.trashSource.classList.remove("active");
    els.rootLabel.textContent = data.root;
    renderFavorites();
    renderDirectoryNavigation();
    renderSearchSummary();
    renderRows();
    renderDetails();
    updateSelection();
    resetContentScroll();
    closeSidebarIfCompact();
  } finally {
    setViewLoading(false);
  }
}

async function loadTrash() {
  clearSearchDebounce();
  cancelPendingSearchRequest();
  setViewLoading(true, "正在读取回收区...");
  try {
    const data = await api("/api/trash");
    resetSearchState();
    state.view = "trash";
    state.trashEntries = data.entries;
    state.selected.clear();
    state.selectionAnchor = null;
    state.focused = data.entries[0] || null;
    els.homeSource.classList.remove("active");
    els.trashSource.classList.add("active");
    renderDirectoryNavigation();
    renderSearchSummary();
    renderRows();
    renderDetails();
    updateSelection();
    resetContentScroll();
    closeSidebarIfCompact();
  } finally {
    setViewLoading(false);
  }
}

async function loadSearch(loadMore = false) {
  if (state.view === "trash") return false;
  const query = els.searchInput.value.trim();
  if (!query) {
    clearSearchDebounce();
    cancelPendingSearchRequest();
    await loadPath(state.path);
    return false;
  }

  const offset = loadMore ? Number(state.search.page?.nextOffset || 0) : 0;
  const button = loadMore ? els.searchLoadMore : els.searchButton;
  const token = searchRequest.token + 1;
  const controller = new AbortController();
  clearSearchDebounce();
  cancelPendingSearchRequest();
  searchRequest.token = token;
  searchRequest.controller = controller;
  button.disabled = true;
  setViewLoading(true, loadMore ? "正在加载更多结果..." : "正在搜索...");
  try {
    const data = await api(`/api/search?${currentSearchOptions(offset).toString()}`, {
      signal: controller.signal,
    });
    if (token !== searchRequest.token) return false;
    state.view = "files";
    state.entries = loadMore ? state.entries.concat(data.results || []) : (data.results || []);
    state.selected.clear();
    state.selectionAnchor = null;
    state.focused = loadMore ? state.focused : null;
    state.search = {
      active: true,
      query,
      page: data.page || null,
      stats: data.stats || null,
    };
    els.homeSource.classList.add("active");
    els.trashSource.classList.remove("active");
    renderDirectoryNavigation();
    renderSearchSummary();
    renderRows();
    renderDetails();
    updateSelection();
    if (!loadMore) resetContentScroll();
    return true;
  } catch (err) {
    if (isAbortError(err)) return false;
    throw err;
  } finally {
    if (searchRequest.controller === controller) searchRequest.controller = null;
    if (searchRequest.token === token) button.disabled = false;
    if (searchRequest.token === token) setViewLoading(false);
  }
}

function scheduleSearchRefresh() {
  if (!state.search.active || state.view === "trash") return;
  clearSearchDebounce();
  searchRequest.debounceTimer = setTimeout(() => {
    searchRequest.debounceTimer = null;
    loadSearch(false).catch((err) => {
      if (!isAbortError(err)) showToast(err.message || String(err), "error", 5200);
    });
  }, SEARCH_DEBOUNCE_MS);
}

async function openTrashAction() {
  await runAction(loadTrash, { pending: "正在打开回收区..." });
}

async function loadDisks() {
  const data = await api("/api/disks");
  state.disks = data.roots;
  renderDisks();
}

function renderDocker() {
  if (!els.dockerList) return;
  const containers = new Map();
  for (const mount of state.dockerMounts) {
    if (!containers.has(mount.container)) containers.set(mount.container, []);
    containers.get(mount.container).push(mount);
  }
  const countEl = $("dockerCount");
  if (countEl) countEl.textContent = containers.size || "";
  els.dockerList.innerHTML = containers.size ? "" : `<div class="empty-note">未发现 Docker 挂载</div>`;
  for (const [name, mounts] of containers) {
    const item = document.createElement("div");
    item.className = "docker-item";
    item.innerHTML = `
      <div class="docker-name">${escapeHtml(name)}</div>
      <div class="docker-meta">${mounts.length} 个挂载</div>
    `;
    els.dockerList.append(item);
  }
}

async function loadDocker() {
  const data = await api("/api/docker");
  state.dockerMounts = data.mounts;
  renderDocker();
}

const PANEL_COLLAPSE_KEY = "unraid-files:collapsed-panels";

function readCollapsedPanels() {
  try {
    const raw = localStorage.getItem(PANEL_COLLAPSE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeCollapsedPanels(map) {
  try {
    localStorage.setItem(PANEL_COLLAPSE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage failures.
  }
}

function applyPanelCollapsed(panel, collapsed) {
  panel.classList.toggle("is-collapsed", collapsed);
  const title = panel.querySelector(".panel-title h2")?.textContent?.trim() || "面板";
  const action = collapsed ? "展开" : "收起";
  for (const toggle of panel.querySelectorAll("[data-panel-toggle]")) {
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", `${action}${title}`);
    toggle.title = `${action}${title}`;
  }
}

function initCollapsiblePanels() {
  const state = readCollapsedPanels();
  for (const panel of document.querySelectorAll(".collapsible-panel")) {
    const key = panel.dataset.panelKey;
    if (!key) continue;
    applyPanelCollapsed(panel, Boolean(state[key]));
    for (const toggle of panel.querySelectorAll(`[data-panel-toggle="${key}"]`)) {
      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        const next = !panel.classList.contains("is-collapsed");
        applyPanelCollapsed(panel, next);
        const map = readCollapsedPanels();
        if (next) map[key] = true;
        else delete map[key];
        writeCollapsedPanels(map);
      });
    }
  }
}

async function promptValue(title, label, value = "") {
  els.promptTitle.textContent = title;
  els.promptLabel.textContent = label;
  els.promptInput.value = value;
  els.promptDialog.returnValue = "";
  els.promptDialog.showModal();
  els.promptInput.focus();
  els.promptInput.select();

  return new Promise((resolve) => {
    els.promptDialog.onclose = () => {
      resolve(els.promptDialog.returnValue === "ok" ? els.promptInput.value.trim() : "");
    };
  });
}

async function pickDirectory(title, initialPath = state.path) {
  let currentPath = initialPath;
  let currentParent = "";
  let closed = false;

  async function loadPickerPath(path) {
    els.directoryList.innerHTML = `<div class="directory-loading">正在读取...</div>`;
    els.directoryEmpty.hidden = true;
    const data = await api(`/api/list?path=${encodeURIComponent(path)}`);
    currentPath = data.path;
    currentParent = data.parent;
    els.directoryPath.textContent = currentPath;
    els.directoryUp.disabled = !currentParent;

    const directories = data.entries
      .filter((entry) => entry.type === "directory")
      .sort((a, b) => compareNatural(a.name, b.name));
    els.directoryList.innerHTML = "";
    els.directoryEmpty.hidden = directories.length !== 0;
    for (const entry of directories) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "directory-item";
      button.innerHTML = `
        <span class="file-icon dir"></span>
        <span>${escapeHtml(entry.name)}</span>
      `;
      button.onclick = () => loadPickerPath(entry.path).catch((err) => showToast(err.message || String(err), "error"));
      els.directoryList.append(button);
    }
  }

  els.directoryTitle.textContent = title;
  els.directoryPath.textContent = "";
  els.directoryUp.disabled = true;
  els.directoryDialog.returnValue = "";
  els.directoryUp.onclick = () => {
    if (currentParent) loadPickerPath(currentParent).catch((err) => showToast(err.message || String(err), "error"));
  };
  els.directoryDialog.showModal();

  const loading = loadPickerPath(initialPath).catch((err) => {
    showToast(err.message || String(err), "error");
    els.directoryDialog.close("cancel");
  });

  return new Promise((resolve) => {
    els.directoryDialog.onclose = () => {
      closed = true;
      resolve(els.directoryDialog.returnValue === "ok" ? currentPath : "");
    };
    loading.finally(() => {
      if (!closed) els.directoryChoose.focus();
    });
  });
}

function isDestinationConflict(err) {
  return /Destination exists:/i.test(err?.message || "");
}

function isSameParentDestination(sources, destination) {
  return sources.length > 0 && sources.every((source) => pathDirname(source) === destination);
}

async function waitForJob(job, label) {
  let canceling = false;
  const toast = createProgressToast(`${label} 0/${job.total || 1}`, "取消", async (button) => {
    if (canceling) return;
    canceling = true;
    button.disabled = true;
    toast.setCancelState("正在取消...", true);
    try {
      await api(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: "POST" });
    } catch (err) {
      canceling = false;
      toast.setCancelState("取消", false);
      showToast(err.message || String(err), "error", 5200);
    }
  });
  try {
    let current = job;
    while (!["done", "error", "canceled"].includes(current.status)) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const data = await api(`/api/jobs/${encodeURIComponent(job.id)}`);
      current = data.job;
      toast.setMessage(`${label} ${current.completed}/${current.total || 1}`);
      if (current.cancelRequested || current.status === "canceled") {
        toast.setCancelState("已取消", true);
      }
    }
    if (current.status === "error") throw new Error(current.error || "操作失败");
    if (current.status === "canceled") return false;
    return current.result;
  } finally {
    toast.remove();
  }
}

async function runJobOperation(operation, payload, label) {
  const data = await api("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ operation, ...payload }),
  });
  return waitForJob(data.job, label);
}

async function transferWithOverwriteRetry(operation, sources, destination, overwriteLabel, options = {}) {
  try {
    await runJobOperation(operation, { sources, destination, ...options }, `正在${overwriteLabel}`);
    return true;
  } catch (err) {
    if (!isDestinationConflict(err)) throw err;
    const shouldOverwrite = confirm(`${overwriteLabel}目标中存在同名项目。是否覆盖已有项目？`);
    if (shouldOverwrite) {
      await runJobOperation(operation, { sources, destination, overwrite: true }, `正在${overwriteLabel}`);
      return true;
    }
    if (operation !== "copy") return false;
    const shouldRename = confirm("是否自动重命名复制出的项目？");
    if (!shouldRename) return false;
    await runJobOperation(operation, { sources, destination, autoRename: true }, `正在${overwriteLabel}`);
    return true;
  }
}

els.homeSource.onclick = () => loadPath(state.root);
els.trashSource.onclick = openTrashAction;
els.sidebarToggle.onclick = () => setSidebarOpen(!document.body.classList.contains("sidebar-open"));
els.sidebarBackdrop.onclick = () => setSidebarOpen(false);
els.directoryNavUp.onclick = () => {
  if (state.view === "files" && state.parent) loadPath(state.parent);
};
els.searchLoadMore.onclick = () => {
  runAction(() => loadSearch(true), { pending: "正在加载更多结果..." });
};
els.searchClear.onclick = () => {
  els.searchInput.value = "";
  loadPath(state.path);
};
function toggleFavoriteAction() {
  if (state.view === "trash") return;
  const idx = state.favorites.indexOf(state.path);
  if (idx >= 0) state.favorites.splice(idx, 1);
  else state.favorites.unshift(state.path);
  state.favorites = [...new Set(state.favorites)].slice(0, 12);
  saveFavorites();
  renderFavorites();
  hideContextMenu();
}
els.refreshDisks.onclick = loadDisks;
if (els.refreshDocker) els.refreshDocker.onclick = loadDocker;
initCollapsiblePanels();

document.querySelectorAll(".sort-button").forEach((button) => {
  button.onclick = () => {
    const key = button.dataset.sort;
    if (!key) return;
    if (state.sort.key === key) {
      state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
    } else {
      state.sort = { key, dir: key === "mtime" ? "desc" : "asc" };
    }
    renderRows();
  };
});
els.listViewButton.onclick = () => setDisplayMode("list");
els.iconViewButton.onclick = () => setDisplayMode("cards");
async function createFolderAction() {
  await runAction(async () => {
    const name = await promptValue("新建文件夹", "文件夹名称");
    if (!name) return false;
    await api("/api/mkdir", {
      method: "POST",
      body: JSON.stringify({ parent: state.path, name }),
    });
    await loadPath(state.path);
    await loadDisks();
    return true;
  }, { pending: "正在新建文件夹...", success: "文件夹已创建" });
}

async function renameAction() {
  await runAction(async () => {
    const entry = activeEntries()[0];
    if (!entry) return false;
    const name = await promptValue("重命名", "新名称", entry.name);
    if (!name || name === entry.name) return false;
    await api("/api/rename", {
      method: "POST",
      body: JSON.stringify({ path: entry.path, name }),
    });
    await loadPath(state.path);
    return true;
  }, { pending: "正在重命名...", success: "已重命名" });
}

async function moveAction() {
  await runAction(async () => {
    const selected = activeEntries();
    if (!selected.length) return false;
    const destination = await pickDirectory("移动到", state.path);
    if (!destination) return false;
    const sources = selected.map((entry) => entry.path);
    if (isSameParentDestination(sources, destination)) {
      showToast("目标目录与当前位置相同", "error");
      return false;
    }
    const completed = await transferWithOverwriteRetry(
      "move",
      sources,
      destination,
      "移动"
    );
    if (!completed) return false;
    await loadPath(state.path);
    await loadDisks();
    return true;
  }, { success: "移动完成" });
}

async function copyAction() {
  await runAction(async () => {
    const selected = activeEntries();
    if (!selected.length) return false;
    const destination = await pickDirectory("复制到", state.path);
    if (!destination) return false;
    const sources = selected.map((entry) => entry.path);
    const autoRename = isSameParentDestination(sources, destination);
    const completed = await transferWithOverwriteRetry(
      "copy",
      sources,
      destination,
      "复制",
      { autoRename }
    );
    if (!completed) return false;
    await loadPath(state.path);
    await loadDisks();
    return true;
  }, { success: "复制完成" });
}

async function trashAction() {
  await runAction(async () => {
    const selected = activeEntries();
    if (!selected.length || !confirm(`将 ${selected.length} 项移动到各磁盘回收区？`)) return false;
    await runJobOperation("delete", { paths: selected.map((entry) => entry.path), permanent: false }, "正在移入回收区");
    await loadPath(state.path);
    await loadDisks();
    return true;
  }, { success: "已移入回收区" });
}

async function deleteAction() {
  await runAction(async () => {
    const selected = activeEntries();
    if (!selected.length || !confirm(`永久删除 ${selected.length} 项？此操作不可恢复。`)) return false;
    await runJobOperation("delete", { paths: selected.map((entry) => entry.path), permanent: true }, "正在永久删除");
    await loadPath(state.path);
    await loadDisks();
    return true;
  }, { success: "已永久删除" });
}

async function restoreAction() {
  await runAction(async () => {
    const selected = selectedTrashEntries();
    if (!selected.length) return false;
    const items = selected.map((entry) => entry.id);
    try {
      await api("/api/trash/restore", {
        method: "POST",
        body: JSON.stringify({ items }),
      });
    } catch (err) {
      if (!isDestinationConflict(err)) throw err;
      if (!confirm("原位置存在同名项目。是否覆盖并恢复？")) return false;
      await api("/api/trash/restore", {
        method: "POST",
        body: JSON.stringify({ items, overwrite: true }),
      });
    }
    await loadTrash();
    await loadDisks();
    return true;
  }, { pending: "正在恢复...", success: "已恢复" });
}

async function purgeAction() {
  await runAction(async () => {
    const selected = selectedTrashEntries();
    if (!selected.length || !confirm(`从回收区永久清除 ${selected.length} 项？`)) return false;
    await api("/api/trash/purge", {
      method: "POST",
      body: JSON.stringify({ items: selected.map((entry) => entry.id) }),
    });
    await loadTrash();
    await loadDisks();
    return true;
  }, { pending: "正在清除...", success: "已清除" });
}

function downloadAction() {
  const entries = activeEntries();
  if (!entries.length) return;
  hideContextMenu();
  if (entries.length === 1 && entries[0].type === "file") {
    window.location.href = `/api/download?path=${encodeURIComponent(entries[0].path)}`;
    return;
  }
  const params = new URLSearchParams();
  for (const entry of entries) params.append("path", entry.path);
  params.set("name", `${state.path.split("/").pop() || "unraid-files"}.tar`);
  window.location.href = `/api/archive?${params.toString()}`;
}

function uploadAction() {
  hideContextMenu();
  if (state.view !== "files") return;
  els.uploadInput.value = "";
  els.uploadInput.click();
}

async function uploadFile(file, overwrite = false) {
  const response = await fetch(`/api/upload?parent=${encodeURIComponent(state.path)}&overwrite=${overwrite}`, {
    method: "POST",
    headers: { "x-file-name": encodeURIComponent(file.name) },
    body: file,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

els.uploadInput.onchange = () => {
  const files = [...els.uploadInput.files];
  if (!files.length) return;
  runAction(async () => {
    for (const file of files) {
      try {
        await uploadFile(file);
      } catch (err) {
        if (err.status !== 409 || !confirm(`${file.name} 已存在，是否覆盖？`)) throw err;
        await uploadFile(file, true);
      }
    }
    await loadPath(state.path);
    await loadDisks();
    return true;
  }, { pending: `正在上传 ${files.length} 个文件...`, success: "上传完成" });
};

function openAction() {
  const entry = activeEntries()[0];
  hideContextMenu();
  if (entry?.type === "directory") loadPath(entry.path);
}

els.tableWrap.oncontextmenu = (event) => {
  if (state.view === "trash") return;
  if (event.target.closest(".file-row") || event.target.closest(".file-card")) return;
  event.preventDefault();
  state.selected.clear();
  state.focused = null;
  state.selectionAnchor = null;
  renderSelectionState();
  renderDetails();
  updateSelection();
  showContextMenu(event.clientX, event.clientY, "blank");
};

els.tableWrap.onclick = (event) => {
  if (event.target.closest(".file-row, .file-card, button, input, thead")) return;
  state.selected.clear();
  state.focused = null;
  state.selectionAnchor = null;
  renderSelectionState();
  renderDetails();
  updateSelection();
};

els.contextMenu.onclick = (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  event.preventDefault();
  dispatchContextAction(button.dataset.action);
};

document.addEventListener("click", (event) => {
  if (!event.target.closest(".context-menu")) hideContextMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideContextMenu();
    setSidebarOpen(false);
  }
  if (
    event.key === "/" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.target.closest("input, textarea, [contenteditable='true']")
  ) {
    event.preventDefault();
    els.searchInput.focus();
    els.searchInput.select();
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "a" &&
    !event.target.closest("input, textarea, select, button, [contenteditable='true']")
  ) {
    event.preventDefault();
    setAllSelection(true);
  }
  if (
    event.key === "F2" &&
    state.view === "files" &&
    state.selected.size === 1 &&
    !event.target.closest("input, textarea, select, button, [contenteditable='true']")
  ) {
    event.preventDefault();
    renameAction();
  }
  if (
    event.key === "Delete" &&
    state.selected.size > 0 &&
    !event.target.closest("input, textarea, select, button, [contenteditable='true']")
  ) {
    event.preventDefault();
    if (state.view === "trash") purgeAction();
    else trashAction();
  }
});

document.addEventListener("scroll", hideContextMenu, true);
window.addEventListener("resize", () => {
  hideContextMenu();
  syncResponsiveLayout();
});

els.searchButton.onclick = () =>
  runAction(async () => {
    return loadSearch(false);
  }, { pending: "正在搜索..." });

els.searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") els.searchButton.click();
  if (event.key === "Escape") {
    els.searchInput.value = "";
    loadPath(state.path);
  }
});
els.searchInput.addEventListener("input", scheduleSearchRefresh);

state.favorites = loadFavorites();
state.displayMode = loadDisplayMode();
renderFavorites();
renderDisplayMode();
syncResponsiveLayout();

Promise.all([loadPath("/"), loadDisks(), loadDocker()]).catch((err) => {
  els.fileRows.innerHTML = "";
  els.emptyState.hidden = false;
  els.emptyState.textContent = err.message || String(err);
});
