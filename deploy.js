#!/usr/bin/env node

/**
 * DollarDeploy CLI (ddc)
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");
const packageJson = require("./package.json");

const DEFAULT_PROVIDER = "hetzner";
const DEFAULT_BASE_URL = "https://dollardeploy.com";
const DEFAULT_TIMEOUT = 600000; // 10 minutes
const AUTH_DIR = path.join(require("os").homedir(), ".dollardeploy");
const AUTH_FILE = path.join(AUTH_DIR, "auth");

const PROVIDER_DEFAULTS = {
  hetzner: {
    type: "cax11",
    region: "fsn1",
    image: "ubuntu-24.04"
  },
  datacrunch: {
    type: "CPU.4V.16G",
    region: "FIN-01",
    image: "ubuntu-24.04"
  },
  do: {
    type: "s-2vcpu-4gb",
    region: "fra1",
    image: "ubuntu-24-04"
  }
};

// User-facing provider aliases mapped to the identifier the API expects.
// "verda" is the current brand for the provider the API still calls "datacrunch".
const PROVIDER_ALIASES = {
  verda: "datacrunch"
};

const normalizeProvider = provider =>
  provider ? (PROVIDER_ALIASES[provider] ?? provider) : provider;

/** @type {typeof console & { verbose: (...args: any[]) => void }} */
const logger = {
  ...console,
  /* eslint-disable-next-line no-console */
  info: (...args) => console.error(...args),
  /* eslint-disable-next-line no-console */
  warn: (...args) => console.error(...args),
  /* eslint-disable-next-line no-console */
  error: (...args) => console.error(...args),
  verbose: (...args) => {
    if (process.env.NEXT_PUBLIC_LOG_VERBOSE === "1") {
      /* eslint-disable-next-line no-console */
      console.error(...args);
    }
  }
};

// ─── Output helpers (AI agent friendly) ──────────────────────────────────────

let jsonOutput = false;

const output = data => {
  if (jsonOutput) {
    logger.log(JSON.stringify(data, null, 2));
  } else if (Array.isArray(data)) {
    if (data.length === 0) {
      logger.info("No results.");
      return;
    }
    const keys = Object.keys(data[0]);
    const widths = keys.map(k =>
      Math.max(k.length, ...data.map(row => String(row[k] ?? "").length))
    );
    const header = keys.map((k, i) => k.padEnd(widths[i])).join("  ");
    const separator = widths.map(w => "-".repeat(w)).join("  ");
    logger.log(header);
    logger.log(separator);
    for (const row of data) {
      logger.log(keys.map((k, i) => String(row[k] ?? "").padEnd(widths[i])).join("  "));
    }
    logger.log("total: " + data.length);
  } else {
    for (const [key, value] of Object.entries(data)) {
      logger.log(`${key}: ${value}`);
    }
  }
};

// Render a value for plain-text (non-JSON) output. Arrays are comma-joined and
// objects (e.g. env, provision) become a compact `key=value` string instead of
// the useless `[object Object]`.
const formatFieldValue = value => {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return value
      .map(item => (item && typeof item === "object" ? JSON.stringify(item) : String(item)))
      .join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([k, v]) => `${k}=${v && typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(", ");
  }
  return String(value);
};

// ─── Auth helpers ────────────────────────────────────────────────────────────

const findAuth = baseUrl => {
  // 1. Environment variable takes priority
  if (process.env.DOLLARDEPLOY_API_KEY) {
    let parsedBaseUrl = undefined;
    if (fs.existsSync(AUTH_FILE)) {
      const content = fs.readFileSync(AUTH_FILE, "utf-8").trim();
      const parsed = JSON.parse(content);
      parsedBaseUrl = parsed.baseUrl;
    }

    return {
      apiKey: process.env.DOLLARDEPLOY_API_KEY,
      baseUrl:
        baseUrl ?? parsedBaseUrl ?? process.env.DOLLARDEPLOY_BASE_URL ?? DEFAULT_BASE_URL
    };
  }

  // 2. Stored auth file
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const content = fs.readFileSync(AUTH_FILE, "utf-8").trim();
      const parsed = JSON.parse(content);
      return {
        apiKey: parsed.apiKey,
        baseUrl:
          baseUrl ?? parsed.baseUrl ?? process.env.DOLLARDEPLOY_BASE_URL ?? DEFAULT_BASE_URL
      };
    } else {
      return {};
    }
  } catch {
    throw new Error(
      "Failed to read auth file. Run `ddc auth` to set it, use --api-key argument or DOLLARDEPLOY_API_KEY env var."
    );
  }
};

const updateAuth = (apiKey, baseUrl) => {
  let existing = {};
  if (fs.existsSync(AUTH_FILE)) {
    existing = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8").trim());
  }
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(
    AUTH_FILE,
    JSON.stringify({ ...existing, apiKey, baseUrl }, null, 2) + "\n",
    {
      mode: 0o600
    }
  );
};

// ─── Prompt helper ───────────────────────────────────────────────────────────

const prompt = question =>
  new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr
    });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });

const confirm = async question => {
  if (process.stdin.isTTY) {
    const answer = await prompt(`${question} [y/N] `);
    return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
  } else {
    throw new Error("Not interactive mode. Use --yes to skip confirmation.");
  }
};

// ─── API client ──────────────────────────────────────────────────────────────

/**
 * @param {Object} auth
 * @returns {Object} API client
 */
const createApiClient = auth => {
  if (!auth.apiKey) {
    throw new Error(
      "API key is required. Run `ddc auth` to set it, or use --api-key or DOLLARDEPLOY_API_KEY."
    );
  }

  const apiKey = auth.apiKey;
  const baseUrl = auth.baseUrl ?? DEFAULT_BASE_URL;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": "DollarDeploy-CLI/" + packageJson.version
  };

  const handleResponse = async response => {
    try {
      if (!response.ok) {
        const error = await response.json();
        throw new Error(`HTTP ${response.status}: ${error.message || response.statusText}`);
      }
      if (response.status === 204) {
        return {};
      }
      return await response.json();
    } catch (error) {
      const err = new Error(
        `API Error (${response.url}: ${response.status}): ${error.message || response.statusText}`
      );
      Object.assign(err, {
        url: response.url,
        status: response.status,
        statusText: response.statusText
      });
      throw err;
    }
  };

  const post = (url, body) => {
    logger.verbose(`POST ${url}...`);
    const startTime = Date.now();
    return fetch(new URL(url, baseUrl).toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    }).then(res => {
      logger.verbose(`POST ${url} (status: ${res.status}) Δ ${Date.now() - startTime}ms`);
      return handleResponse(res);
    });
  };

  const patch = (url, body) => {
    logger.verbose(`PATCH ${url}...`);
    const startTime = Date.now();
    return fetch(new URL(url, baseUrl).toString(), {
      method: "PATCH",
      headers,
      body: JSON.stringify(body)
    }).then(res => {
      logger.verbose(`PATCH ${url} (status: ${res.status}) Δ ${Date.now() - startTime}ms`);
      return handleResponse(res);
    });
  };

  const del = url => {
    logger.verbose(`DELETE ${url}...`);
    const startTime = Date.now();
    return fetch(new URL(url, baseUrl).toString(), {
      method: "DELETE",
      headers
    }).then(res => {
      logger.verbose(`DELETE ${url} (status: ${res.status}) Δ ${Date.now() - startTime}ms`);
      return handleResponse(res);
    });
  };

  const get = url => {
    logger.verbose(`GET ${url}...`);
    const startTime = Date.now();
    return fetch(new URL(url, baseUrl).toString(), {
      method: "GET",
      headers
    }).then(res => {
      logger.verbose(`GET ${url} (status: ${res.status}) Δ ${Date.now() - startTime}ms`);
      return handleResponse(res);
    });
  };

  return {
    baseUrl,
    createHost: name => post("/api/host/create", { name }),
    getHost: id => get(`/api/host/${id}`),
    listHosts: status => get(`/api/host${status ? `?status=${status}` : ""}`),
    updateHost: (id, data) => patch(`/api/host/${id}`, data),
    deleteHost: id => del(`/api/host/${id}`),
    getProvision: hostId =>
      get(`/api/host/${hostId}/provision`).catch(err => {
        if (err.status === 404) {
          return undefined;
        }
        throw err;
      }),
    saveProvision: (hostId, data) => patch(`/api/host/${hostId}/provision`, data),
    provisionHost: hostId => post(`/api/host/${hostId}/provision`),
    getProviderConfig: (provider, filters = {}) =>
      get(
        `/api/provider/${provider}?` +
          Object.entries(filters)
            .filter(([, v]) => v !== undefined && v !== null && v !== "")
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
            .join("&")
      ),
    testConnection: hostId => post(`/api/host/${hostId}/test`),
    prepareHost: hostId => post(`/api/host/${hostId}/prepare`),
    createService: (hostId, type) => post(`/api/host/${hostId}/service/create`, { type }),
    listServices: hostId => get(`/api/host/${hostId}/service`),
    getService: (hostId, serviceId) => get(`/api/host/${hostId}/service/${serviceId}`),
    deleteService: (hostId, serviceId) => del(`/api/host/${hostId}/service/${serviceId}`),
    startProvision: hostId => post(`/api/host/${hostId}/provision`),
    deprovisionHost: (hostId, deleteHost = true) =>
      post(`/api/host/${hostId}/deprovision`, { deleteHost }),
    getTask: id => get(`/api/task/${id}`),
    listTasks: status => get(`/api/task${status ? `?status=${status}` : ""}`),
    cancelTask: id => post(`/api/task/${id}/cancel`),
    getTaskJournal: id => get(`/api/journal/latest?taskId=${id}`),
    getLogs: params =>
      get(
        "/api/journal/latest?" +
          Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== null && v !== "")
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
            .join("&")
      ),
    getTemplates: () => get("/api/template"),
    getTemplate: id => get(`/api/template/${id}`),
    launchTemplate: args => post("/api/task/launch", args),
    getApp: id => get(`/api/app/${id}`),
    getUser: () => get("/api/user"),
    listApps: () => get("/api/app"),
    createApp: args => post("/api/app/create", args),
    suggestApp: app => post("/api/app/suggest", app),
    updateApp: (id, data) => patch(`/api/app/${id}`, data),
    buildApp: (id, options = {}) => post(`/api/app/${id}/build`, options),
    deployApp: (id, options = {}) => post(`/api/app/${id}/deploy`, options),
    deleteApp: id => del(`/api/app/${id}`),
    removeApp: (id, options = { deleteApp: false }) => post(`/api/app/${id}/remove`, options),
    listSshKeys: () => get("/api/settings/privateKey"),
    createSshKey: data => post("/api/settings/privateKey/create", data),
    deleteSshKey: id => del(`/api/settings/privateKey/${id}`)
  };
};

// ─── Utility functions ───────────────────────────────────────────────────────

const shorten = (text, maxLength = 90) => {
  if (!text) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + "...";
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const waitForTask = async (api, taskId, timeout = DEFAULT_TIMEOUT) => {
  const startTime = Date.now();
  const pollInterval = 2000;
  logger.verbose(`Waiting for task ${taskId}...`);

  while (Date.now() - startTime < timeout) {
    const task = await api.getTask(taskId);
    const journal = await api.getTaskJournal(taskId);

    const message = shorten(journal.logs[0]?.message?.trim());
    if (message) {
      logger.info(`Task (${task.type}) ${task.status}: ${message}`);
    } else {
      logger.info(`Task (${task.type}) ${task.status}`);
    }

    if (task.status === "completed") {
      if (task.nextTaskId) {
        return await waitForTask(api, task.nextTaskId, timeout);
      }
      return task;
    }

    if (task.status === "error" || task.status === "cancelled") {
      throw new Error(
        `Task ${taskId} failed: ${task.status} (${shorten(journal.logs[0]?.message?.trim() ?? "No message")})`
      );
    }

    await sleep(pollInterval);
  }

  throw new Error(`Task ${taskId} timed out after ${timeout}ms`);
};

const RETRY_HTTP_ERRORS = [502, 503, 504];

const checkUrl = async (url, maxRetries = 20, retryDelay = 2000) => {
  logger.verbose(`Checking ${url}...`);

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": "DollarDeploy-CLI/" + packageJson.version },
        signal: AbortSignal.timeout(10000)
      });

      if (!RETRY_HTTP_ERRORS.includes(response.status)) {
        logger.verbose(`URL responding (status: ${response.status})`);
        return response.status;
      }

      logger.verbose(`URL ${url} status ${response.status}, retrying...`);
    } catch (error) {
      logger.verbose(`Attempt ${i + 1}/${maxRetries}: ${error.message}`);
    }

    if (i < maxRetries - 1) {
      await sleep(retryDelay);
    }
  }

  throw new Error(`URL ${url} not accessible after ${maxRetries} attempts`);
};

// Verify the deployed URL is responding, but never fail the deploy over it —
// the app is already deployed, so a slow first boot shouldn't report an error.
const verifyDeployedUrl = async appUrl => {
  logger.info(`Checking ${appUrl}...`);
  try {
    await checkUrl(appUrl);
    logger.info(`Deployed: ${appUrl}`);
  } catch (error) {
    logger.warn(`Deployed, but ${appUrl} is not responding yet: ${error.message}`);
  }
};

// ─── Local folder detection (git + env files) ────────────────────────────────

// Run a git command in `dir` and return trimmed stdout, or "" on any failure
// (not a repo, git missing, no remote). git errors are swallowed on purpose so
// detection degrades gracefully into a clear CLI message.
const runGit = (dir, args) => {
  try {
    return execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
};

// Normalize any git remote URL to a plain https GitHub-style URL:
//   git@github.com:org/repo.git       -> https://github.com/org/repo
//   ssh://git@github.com/org/repo.git -> https://github.com/org/repo
//   https://user:token@github.com/... -> https://github.com/...
const normalizeRepoUrl = raw => {
  if (!raw) {
    return undefined;
  }
  let url = raw.trim();
  const scpMatch = url.match(/^git@([^:]+):(.+)$/);
  if (scpMatch) {
    url = `https://${scpMatch[1]}/${scpMatch[2]}`;
  }
  url = url.replace(/^ssh:\/\/git@/, "https://").replace(/^git\+https:\/\//, "https://");
  url = url.replace(/^(https?:\/\/)[^@/]+@/, "$1");
  url = url.replace(/\/+$/, "").replace(/\.git$/, "");
  return url;
};

// Detect the git repository in `dir`: normalized remote URL, current branch,
// list of uncommitted changes, and count of commits not pushed upstream.
// Returns null when `dir` is not inside a git work tree.
const getGitInfo = dir => {
  if (runGit(dir, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    return null;
  }

  const branch = runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) || undefined;

  let rawUrl = runGit(dir, ["remote", "get-url", "origin"]);
  if (!rawUrl) {
    const firstRemote = runGit(dir, ["remote"]).split("\n").filter(Boolean)[0];
    if (firstRemote) {
      rawUrl = runGit(dir, ["remote", "get-url", firstRemote]);
    }
  }

  const status = runGit(dir, ["status", "--porcelain"]);
  const dirty = status ? status.split("\n").filter(Boolean) : [];

  const aheadRaw = runGit(dir, ["rev-list", "--count", "@{u}..HEAD"]);
  const ahead = /^\d+$/.test(aheadRaw) ? parseInt(aheadRaw, 10) : 0;

  return { repoUrl: normalizeRepoUrl(rawUrl), branch, dirty, ahead };
};

// Parse KEY=VALUE lines from a .env file body. Ignores blanks and comments,
// tolerates a leading `export `, and strips matching surrounding quotes.
const parseEnvFile = content => {
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eqIndex = body.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }
    const key = body.slice(0, eqIndex).trim();
    if (!key) {
      continue;
    }
    let value = body.slice(eqIndex + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
};

// Real env files are read in priority order (first match wins per key). Keys
// present only in .env.example (or empty everywhere) become placeholders the
// user must fill at dollardeploy.com.
const LOCAL_ENV_FILES = [
  ".env.production",
  ".env.prod",
  ".env.production.local",
  ".env.local"
];

const readLocalEnv = dir => {
  const values = {};
  const sources = {};

  for (const file of LOCAL_ENV_FILES) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) {
      continue;
    }
    const parsed = parseEnvFile(fs.readFileSync(full, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (value === "" || values[key] !== undefined) {
        continue;
      }
      values[key] = value;
      sources[key] = file;
    }
  }

  const placeholders = [];
  const examplePath = path.join(dir, ".env.example");
  if (fs.existsSync(examplePath)) {
    const example = parseEnvFile(fs.readFileSync(examplePath, "utf8"));
    for (const key of Object.keys(example)) {
      if (values[key] === undefined) {
        placeholders.push(key);
      }
    }
  }

  return { values, sources, placeholders };
};

// Never print env values to the terminal or scrollback (they may be secrets).
// Only key names are shown; values are always masked in the overview.
const maskEnvValue = value => (value === undefined || value === "" ? "<empty>" : "********");

// Read-only preview of which host a local deploy will target, for the overview.
const resolveHostLabel = async (api, hostId, flags) => {
  if (hostId) {
    const host = await api.getHost(hostId).catch(() => null);
    return host ? host.name || host.id : hostId;
  }
  if (flags["create-host"]) {
    const provider = normalizeProvider(flags.provider) || DEFAULT_PROVIDER;
    return `new ${provider} host (will be provisioned)`;
  }
  const activeHosts = (await api.listHosts("active")).filter(h => h.status === "active");
  if (activeHosts.length === 1) {
    return `${activeHosts[0].name || activeHosts[0].id} (only active host)`;
  }
  if (activeHosts.length > 1) {
    return "multiple active hosts - pick one with --hostId <id>";
  }
  return "none - an app entry will be created, select a server at dollardeploy.com";
};

// Print the "what will be deployed" summary shown before a local-folder deploy.
const printDeployOverview = ({
  repoUrl,
  branch,
  dirty,
  ahead,
  hostLabel,
  values,
  sources,
  placeholders,
  cliEnv
}) => {
  logger.info("");
  logger.info("Deploy overview");
  logger.info(`  Repository:  ${repoUrl}`);
  if (branch) {
    logger.info(`  Branch:      ${branch}`);
  }
  logger.info(`  Target host: ${hostLabel}`);

  if (dirty.length > 0) {
    logger.warn(
      `  Warning: ${dirty.length} uncommitted change(s) - the deploy builds from the remote, so uncommitted edits will not ship until committed and pushed.`
    );
  }
  if (ahead > 0) {
    logger.warn(
      `  Warning: ${ahead} commit(s) not pushed to the remote - they will not be included in this deploy.`
    );
  }

  const envKeys = Array.from(new Set([...Object.keys(values), ...Object.keys(cliEnv)])).sort();
  if (envKeys.length > 0) {
    logger.info("  Environment variables (values hidden):");
    for (const key of envKeys) {
      const fromCli = cliEnv[key] !== undefined;
      const source = fromCli ? "--env" : sources[key] || "local";
      const value = fromCli ? cliEnv[key] : values[key];
      logger.info(`    ${key} = ${maskEnvValue(value)} (${source})`);
    }
  }

  if (placeholders.length > 0) {
    logger.info("  Needs a value at dollardeploy.com (from .env.example):");
    for (const key of placeholders) {
      logger.info(`    ${key}`);
    }
  }
  logger.info("");
};

// ─── Argument parser ─────────────────────────────────────────────────────────

const parseArgs = argv => {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        if (flags[key] !== undefined && key === "env") {
          // Only allow multiple env values if the key is "env"
          if (!Array.isArray(flags[key])) {
            flags[key] = [flags[key]];
          }
          flags[key].push(next);
        } else {
          flags[key] = next;
        }
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const shortMap = { v: "verbose", j: "json", h: "help", V: "version", f: "follow" };
      const mapped = shortMap[arg[1]];
      if (mapped) {
        flags[mapped] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
};

// ─── Commands ────────────────────────────────────────────────────────────────

const cmdAuth = async (_api, _positional, flags) => {
  const apiKey = flags["api-key"] || flags.apiKey;
  const baseUrl = flags["base-url"] || flags.baseUrl;

  if (apiKey) {
    updateAuth(apiKey, baseUrl);
    logger.info("API key saved to ~/.dollardeploy/auth");
    return;
  }

  // Interactive mode
  const key = await prompt("Enter your DollarDeploy API key: ");
  if (!key) {
    logger.error("No API key provided. Aborting.");
    process.exit(1);
  }

  updateAuth(key, baseUrl);
  logger.info("API key saved to ~/.dollardeploy/auth");
};

const cmdHostList = async (api, _positional, flags) => {
  const status = flags.status || undefined;
  const hosts = await api.listHosts(status);

  if (jsonOutput || flags.all) {
    output(hosts);
    return;
  }

  const rows = hosts.map(h => ({
    id: h.id,
    name: h.name || "",
    status: h.status ?? "draft",
    ip: h.ipAddress || "",
    apps: h.apps?.length ?? 0,
    createdAt: h.createdAt
  }));

  output(rows);
};

const cmdHostGet = async (api, positional, flags) => {
  const hostId = positional[0] || flags.hostId;
  const help = flags.help;

  if (!hostId || help) {
    logger.info("ddc host get <host-id> [--all]");
    process.exit(hostId ? 0 : 1);
  }

  const host = await api.getHost(hostId);
  const provision = await api.getProvision(hostId);

  if (jsonOutput || flags.all) {
    output({ ...host, provision });
    return;
  }

  // Plain text: show all host fields except noisy objects, plus formatted provision.
  const excluded = new Set(["health", "apps", "project"]);
  const row = {};
  for (const [key, value] of Object.entries(host)) {
    if (excluded.has(key)) {
      continue;
    }
    row[key] = formatFieldValue(value);
  }
  row.provision = provision ? formatFieldValue(provision) : "";
  output(row);
};

const cmdAppList = async (api, _positional, flags) => {
  const help = flags.help;

  if (help) {
    logger.info("ddc app list [--fields <fields>|--all]");
    process.exit(0);
  }

  const apps = await api.listApps();

  if (jsonOutput || flags.all) {
    output(apps);
    return;
  }

  const fields = flags.fields?.split(",") || [
    "id",
    "name",
    "status",
    "repositoryUrl",
    "hostname"
  ];

  const rows = apps.map(a =>
    Object.fromEntries(
      fields.map(f => [f, f === "hostname" && a[f] ? "https://" + a[f] : a[f]])
    )
  );

  output(rows);
};

const cmdAppGet = async (api, positional, flags) => {
  const appId = positional[0] || flags.appId;
  const help = flags.help;

  if (!appId || help) {
    logger.info("ddc app get <app-id> [--fields <fields>|--all]");
    process.exit(appId ? 0 : 1);
  }

  const app = await api.getApp(appId);

  if (jsonOutput || flags.all) {
    output(app);
    return;
  }

  if (flags.fields) {
    const fields = flags.fields.split(",");
    output(
      Object.fromEntries(
        fields.map(f => [f, f === "hostname" && app[f] ? "https://" + app[f] : (app[f] ?? "")])
      )
    );
    return;
  }

  // Plain text: show all app fields except noisy objects (host, project).
  const excluded = new Set(["host", "project"]);
  const row = {};
  for (const [key, value] of Object.entries(app)) {
    if (excluded.has(key)) {
      continue;
    }
    row[key] = key === "hostname" && value ? "https://" + value : formatFieldValue(value);
  }
  output(row);
};

const cmdSshList = async (api, _positional, flags) => {
  const sshKeys = await api.listSshKeys();
  const name = flags.name;
  const help = flags.help;

  if (help) {
    logger.info("ddc ssh list [--name <name>]");
    process.exit(1);
  }

  const rows = sshKeys
    .filter(k => (name ? k.name === name : true))
    .map(k => ({
      id: k.id,
      name: k.name || "",
      createdAt: k.createdAt,
      fingerprint: k.fingerprint
    }));

  output(rows);
};

const cmdHostCreate = async (api, _positional, flags) => {
  const name = flags.name || undefined;
  const provider = normalizeProvider(flags.provider);
  const providerType = flags.type || PROVIDER_DEFAULTS[provider]?.type;
  const providerRegion = flags.region || PROVIDER_DEFAULTS[provider]?.region;
  const image = flags.image || PROVIDER_DEFAULTS[provider]?.image;
  const timeout = parseInt(flags.timeout) || DEFAULT_TIMEOUT;
  const services = flags.services?.split(",") || ["docker"];
  const skipPrepare = flags["skip-prepare"] === true;

  logger.info("Creating host...");
  const host = await api.createHost(name);
  logger.info(`Host created: ${host.id} (${host.name})`);

  if (provider) {
    if (!providerType || !providerRegion || !image) {
      throw new Error(
        `Incomplete config for ${provider}: type=${providerType}, region=${providerRegion}, image=${image}`
      );
    }

    logger.info(`Provisioning ${provider} (${providerType} in ${providerRegion})...`);
    await api.saveProvision(host.id, {
      provider,
      providerType,
      providerRegion,
      image
    });

    const provisionTask = await api.startProvision(host.id);
    await waitForTask(api, provisionTask.id, timeout);
    logger.info("Instance provisioned.");

    const updatedHost = await api.getHost(host.id);
    if (updatedHost.status !== "active") {
      throw new Error(`Host is not active. Status: ${updatedHost.status}`);
    }

    if (!skipPrepare) {
      await api.updateHost(host.id, { swap: 4096 });

      logger.info("Testing connection...");
      await api.testConnection(host.id).then(task => waitForTask(api, task.id, timeout));

      for (const type of services) {
        const existingServices = await api.listServices(host.id);
        if (!existingServices?.find(s => s.type === type)) {
          logger.info(`Installing ${type}...`);
          await api.createService(host.id, type);
        }
      }

      logger.info("Preparing host...");
      await api.prepareHost(host.id).then(task => waitForTask(api, task.id, timeout));
    }
  }

  logger.info("Host ready.");

  const finalHost = await api.getHost(host.id);
  const provision = await api.getProvision(host.id);
  output({
    id: finalHost.id,
    name: finalHost.name,
    status: finalHost.status ?? "draft",
    ip: finalHost.ipAddress || "<not assigned>",
    provision: provision?.provider
  });
};

const cmdHostDestroy = async (api, positional, flags) => {
  const hostId = positional[0] || flags.hostId;
  if (!hostId) {
    logger.error("ddc host destroy <host-id>");
    process.exit(1);
  }

  const timeout = parseInt(flags.timeout) || DEFAULT_TIMEOUT;
  const host = await api.getHost(hostId);

  if (!flags.yes && !flags.force) {
    const ok = await confirm(
      `This will deprovision and permanently delete host "${host.name || host.id}" (${host.ipAddress || "no IP"}).\nContinue?`
    );
    if (!ok) {
      logger.info("Aborted.");
      return;
    }
  }

  // Remove all apps on the host first
  if (host.apps?.length > 0) {
    for (const app of host.apps) {
      logger.info(`Removing app ${app.name || app.id}...`);
      const removeTask = await api.removeApp(app.id, { deleteApp: true });
      await waitForTask(api, removeTask.id, timeout);
    }
  }

  logger.info("Deprovisioning host...");
  const deprovisionTask = await api.deprovisionHost(hostId);
  await waitForTask(api, deprovisionTask.id, timeout);
  logger.info(`Host ${hostId} destroyed.`);
};

const cmdHostRemove = async (api, positional, flags) => {
  const hostId = positional[0] || flags.hostId;
  if (!hostId) {
    logger.error("ddc host remove <host-id>");
    process.exit(1);
  }

  const host = await api.getHost(hostId);

  if (!flags.yes && !flags.force) {
    const ok = await confirm(
      `This will remove host "${host.name || host.id}" from DollarDeploy\nThe server instance will NOT be deprovisioned.\nContinue?`
    );
    if (!ok) {
      logger.info("Aborted.");
      return;
    }
  }

  await api.deleteHost(hostId);
  logger.info(`Host ${hostId} removed from DollarDeploy.`);
};

const cmdUser = async api => {
  const user = await api.getUser();
  output({ id: user.id, name: user.name, email: user.email });
};

const cmdHostPrepare = async (api, positional, flags) => {
  const timeout = parseInt(flags.timeout) || DEFAULT_TIMEOUT;
  const hostId = positional[0] || flags.hostId;
  if (!hostId) {
    logger.error("ddc host prepare <host-id>");
    process.exit(1);
  }

  await api.getHost(hostId);
  const task = await api.prepareHost(hostId);
  logger.info(`Host ${hostId} prepare task started.`);
  await waitForTask(api, task.id, timeout);
  logger.info(`Host ${hostId} prepared.`);
  const host = await api.getHost(hostId);
  output({ id: host.id, name: host.name, status: host.status });
};

const cmdAppDeploy = async (api, _positional, flags) => {
  const timeout = parseInt(flags.timeout) || DEFAULT_TIMEOUT;
  let url = flags.url;
  const templateId = flags.template || flags.templateId;
  const help = flags.help;
  let appId = flags.appId;
  let hostId = flags.hostId;

  if (help) {
    logger.info(
      "ddc app deploy [--url <github-url> | --template <id> | --appId <id>] [--hostId <id>] [--env NAME=VALUE ...]\n" +
        "  With no --url/--template/--appId, deploys the git repo in the current folder\n" +
        "  (detects the remote URL, reads .env.production/.env.prod/.env.local and\n" +
        "  .env.example placeholders, shows a confirmation overview, then deploys).\n" +
        "  --path <dir>  deploy a different folder   --yes  skip the confirmation prompt"
    );
    process.exit(0);
  }

  // ─── Local-folder-aware deploy ─────────────────────────────────────────────
  // With no --url/--template/--appId, detect the git repo in the current folder
  // (Vercel-style): read the remote URL, branch, dirty state and local env files.
  let localEnv = {};
  let localSources = {};
  let localPlaceholders = [];
  let sourceBranch = flags.sourceBranch;
  let gitInfo = null;
  let fromLocal = false;

  if (!url && !templateId && !appId) {
    const projectDir = flags.path || process.cwd();
    gitInfo = getGitInfo(projectDir);
    if (!gitInfo || !gitInfo.repoUrl) {
      logger.error(
        `ddc app deploy: no git repository with a remote found in ${projectDir}.\n` +
          "Run this inside a git repo, or pass --url <github-url>, --template <id>, or --appId <id>."
      );
      process.exit(1);
    }
    fromLocal = true;
    url = gitInfo.repoUrl;
    if (!sourceBranch) {
      sourceBranch = gitInfo.branch;
    }
    const local = readLocalEnv(projectDir);
    localEnv = local.values;
    localSources = local.sources;
    localPlaceholders = local.placeholders;
  }

  // Derive a default app name from the repo URL when none was provided.
  const repoName = url ? url.split("/").pop() : undefined;
  const appName = flags.name || templateId || repoName;

  // Resolve an existing app by repository URL so we redeploy instead of
  // creating a duplicate.
  if (url) {
    const apps = await api.listApps();
    const existing = apps.find(
      app => app.repositoryUrl === url && (hostId ? app.hostId === hostId : true)
    );
    if (existing) {
      logger.info(`Existing appId ${existing.id} name ${existing.name}`);
      appId = existing.id;
    }
  }

  // Confirmation overview (Vercel-style) for local-folder deploys.
  if (fromLocal) {
    let hostLabel;
    if (appId) {
      const existingApp = await api.getApp(appId);
      if (existingApp.hostId) {
        const existingHost = await api.getHost(existingApp.hostId).catch(() => null);
        hostLabel = `${existingHost?.name || existingApp.hostId} (redeploy existing app)`;
      } else {
        hostLabel =
          "none - app has no server yet, select one at dollardeploy.com (redeploy existing app)";
      }
    } else {
      hostLabel = await resolveHostLabel(api, hostId, flags);
    }

    printDeployOverview({
      repoUrl: url,
      branch: sourceBranch,
      dirty: gitInfo.dirty,
      ahead: gitInfo.ahead,
      hostLabel,
      values: localEnv,
      sources: localSources,
      placeholders: localPlaceholders,
      cliEnv: extractEnvFlags(flags)
    });

    if (!flags.yes) {
      const ok = await confirm("Proceed with this deploy?");
      if (!ok) {
        logger.info("Aborted.");
        return;
      }
    }
  }

  // Redeploy existing app
  if (appId) {
    logger.info(`Redeploying app ${appId}...`);
    const app = await api.getApp(appId);
    logger.verbose(`App: ${app.name} on host ${app.hostId}`);

    // Apply local env files, --env and --set overrides. Local placeholders are
    // skipped on redeploy so they never blank existing values.
    const envOverrides = { ...localEnv, ...extractEnvFlags(flags) };
    const propOverrides = extractAppFlags(flags);
    if (sourceBranch && propOverrides.sourceBranch === undefined) {
      propOverrides.sourceBranch = sourceBranch;
    }
    if (Object.keys(envOverrides).length > 0 || Object.keys(propOverrides).length > 0) {
      logger.info(`Updating app ${appId} with env and prop overrides...`);
      await api.updateApp(appId, {
        ...propOverrides,
        ...(Object.keys(envOverrides).length > 0
          ? { env: { ...app.env, ...envOverrides } }
          : {})
      });
    }

    logger.info(`Building and deploying app ${appId}...`);
    const task = await api.buildApp(appId, { deploy: true });
    await waitForTask(api, task.id, timeout);
    logger.info(`Deployed: https://${app.hostname}`);

    output({ id: app.id, name: app.name, url: `https://${app.hostname}`, status: "deployed" });
    return;
  }

  // Create host if needed
  if (!hostId && flags["create-host"]) {
    const provider = normalizeProvider(flags.provider) || DEFAULT_PROVIDER;
    const providerType = flags.type || PROVIDER_DEFAULTS[provider]?.type;
    const providerRegion = flags.region || PROVIDER_DEFAULTS[provider]?.region;
    const image = flags.image || PROVIDER_DEFAULTS[provider]?.image;

    logger.info("Creating host...");
    const host = await api.createHost();
    hostId = host.id;
    logger.info(`Host created: ${host.id}`);

    logger.info(`Provisioning ${provider} (${providerType} in ${providerRegion})...`);
    await api.saveProvision(hostId, { provider, providerType, providerRegion, image });

    const provisionTask = await api.startProvision(hostId);
    await waitForTask(api, provisionTask.id, timeout);
    logger.info("Instance provisioned.");

    const updatedHost = await api.getHost(hostId);
    if (updatedHost.status !== "active") {
      throw new Error(`Host is not active. Status: ${updatedHost.status}`);
    }

    await api.updateHost(hostId, { swap: 4096 });

    logger.info("Testing connection...");
    await api.testConnection(hostId).then(task => waitForTask(api, task.id, timeout));

    const services = flags.services?.split(",") || ["docker"];
    for (const type of services) {
      const existingServices = await api.listServices(hostId);
      if (!existingServices?.find(s => s.type === type)) {
        logger.info(`Installing ${type}...`);
        await api.createService(hostId, type);
      }
    }

    logger.info("Preparing host...");
    await api.prepareHost(hostId).then(task => waitForTask(api, task.id, timeout));
    logger.info("Host ready.");
  }

  // Auto-select the host when none was given and exactly one active host exists.
  if (!hostId) {
    const activeHosts = (await api.listHosts("active")).filter(h => h.status === "active");
    if (activeHosts.length === 1) {
      hostId = activeHosts[0].id;
      logger.info(`Using host ${activeHosts[0].name || hostId} (only active host).`);
    } else if (activeHosts.length > 1) {
      logger.error(
        "Multiple active hosts found. Specify one with --hostId <id>:\n" +
          activeHosts.map(h => `  ${h.id}  ${h.name || ""}`).join("\n")
      );
      process.exit(1);
    }
  }

  // No host available: for a repo deploy, create an app entry with no server
  // selected so the user can pick one at dollardeploy.com, then exit cleanly.
  if (!hostId && url) {
    const envOverrides = { ...localEnv, ...extractEnvFlags(flags) };
    const propOverrides = extractAppFlags(flags);
    if (sourceBranch && propOverrides.sourceBranch === undefined) {
      propOverrides.sourceBranch = sourceBranch;
    }
    const placeholderEnv = Object.fromEntries(localPlaceholders.map(key => [key, ""]));

    const app = await api.createApp({
      repositoryUrl: url,
      name: appName,
      ...propOverrides,
      env: { ...placeholderEnv, ...envOverrides }
    });

    const appLink = `${api.baseUrl}/app/${app.id}`;
    logger.info("No active host found - created an app entry with no server selected.");
    logger.info(`Select a server to deploy it: ${appLink}`);
    output({ id: app.id, name: app.name, status: app.status, url: appLink });
    return;
  }

  if (!hostId) {
    logger.error(
      "ddc app deploy: no active host found. Use --hostId <id> to deploy to an existing host, or --create-host to provision a new host."
    );
    process.exit(1);
  }

  const host = await api.getHost(hostId);
  if (host.status !== "active") {
    throw new Error(`Host is not active. Status: ${host.status}`);
  }

  // Resolve hostname
  let hostname = host.hostnames.find(h => !host.apps?.find(a => a.hostname === h));
  const wildcard = host.hostnames.find(
    h => h.endsWith(".dollardeploy.app") || h.endsWith(".dollardeploy.dev")
  );

  if (wildcard && appName) {
    hostname = appName + "." + wildcard.split(".").slice(1).join(".");
    let index = 1;
    while (host.hostnames.includes(hostname)) {
      index++;
      hostname = appName + index + "." + wildcard.split(".").slice(1).join(".");
    }
    await api.updateHost(hostId, {
      hostnames: Array.from(new Set([...host.hostnames, hostname]))
    });
  }

  if (!hostname) {
    throw new Error("No available hostname found on host: " + hostId);
  }

  if (url) {
    logger.info(`Deploying new app from ${url}...`);
    let app = await api.createApp({
      repositoryUrl: url,
      hostId,
      hostname,
      mainPort: Math.max(...(host.apps?.map(a => a.mainPort ?? 3000) ?? [3000])) + 1,
      name: appName
    });

    logger.info("Analyzing repository...");
    const suggestions = await api.suggestApp(app);
    logger.verbose(
      `AI suggestions: ${suggestions.map(s => `${s.property}: ${JSON.stringify(s.value ?? s.values)}`).join(", ")}`
    );

    const envOverrides = { ...localEnv, ...extractEnvFlags(flags) };
    const propOverrides = extractAppFlags(flags);
    if (sourceBranch && propOverrides.sourceBranch === undefined) {
      propOverrides.sourceBranch = sourceBranch;
    }
    // .env.example keys become empty placeholders to fill at dollardeploy.com,
    // but never override an AI suggestion or a real local/CLI value.
    const placeholderEnv = Object.fromEntries(localPlaceholders.map(key => [key, ""]));

    app = await api.updateApp(app.id, {
      ...Object.fromEntries(
        suggestions.filter(s => s.property !== "env").map(s => [s.property, s.value])
      ),
      ...propOverrides,
      env: {
        ...placeholderEnv,
        ...Object.assign(
          {},
          ...suggestions.filter(s => s.property === "env").map(s => s.values)
        ),
        ...envOverrides
      }
    });

    logger.info("Building and deploying...");
    const task = await api.buildApp(app.id, { deploy: true });
    await waitForTask(api, task.id, timeout);

    const appUrl = `https://${hostname}`;
    await verifyDeployedUrl(appUrl);

    output({ id: app.id, name: app.name, url: appUrl, status: "deployed" });
  } else if (templateId) {
    logger.verbose("Fetching templates...");
    const templates = await api.getTemplates();
    const template = templates.find(t => t.id === templateId);
    if (!template) {
      throw new Error(
        `Template "${templateId}" not found. Run \`ddc template list\` to see available templates.`
      );
    }

    logger.info(`Launching ${template.name}...`);
    const launchTask = await api.launchTemplate({
      templateId,
      hostId,
      hostname,
      skipCache: true
    });

    await waitForTask(api, launchTask.id, timeout);

    const completedTask = await api.getTask(launchTask.id);
    if (!completedTask.appId) {
      throw new Error("Task completed but no appId found");
    }

    const appUrl = `https://${hostname}`;
    await verifyDeployedUrl(appUrl);

    output({ id: completedTask.appId, url: appUrl, status: "deployed" });
  }
};

const cmdAppBuild = async (api, positional, flags) => {
  const appId = positional[0] || flags.appId;
  const deploy = flags.deploy === true;
  const timeout = parseInt(flags.timeout) || DEFAULT_TIMEOUT;

  if (!appId) {
    logger.error("ddc build: use [<app-id> | --appId <app-id>] [--deploy]");
    process.exit(1);
  }

  const app = await api.getApp(appId);
  logger.info(`Building ${app.name}...`);

  const task = await api.buildApp(appId, { deploy });
  await waitForTask(api, task.id, timeout);

  if (deploy) {
    logger.info(`Built and deployed: https://${app.hostname}`);
  } else {
    logger.info("Build completed.");
  }

  output({ id: app.id, name: app.name, status: deploy ? "deployed" : "built" });
};

const collectAppPayload = flags => {
  const payload = {};
  const fieldMap = {
    name: "name",
    url: "repositoryUrl",
    type: "type",
    hostId: "hostId",
    hostname: "hostname",
    mainPort: "mainPort",
    sourcePath: "sourcePath",
    sourceBranch: "sourceBranch",
    startScript: "startScript",
    startCmd: "startCmd",
    buildScript: "buildScript",
    buildCmd: "buildCmd",
    installCmd: "installCmd",
    dockerComposeFile: "dockerComposeFile",
    preStartCmd: "preStartCmd",
    postStartCmd: "postStartCmd",
    buildPath: "buildPath",
    webPath: "webPath",
    buildIncludeFiles: "buildIncludeFiles",
    description: "description"
  };

  for (const [flag, field] of Object.entries(fieldMap)) {
    if (flags[flag] !== undefined && flags[flag] !== true) {
      payload[field] = flag === "mainPort" ? parseInt(flags[flag], 10) : flags[flag];
    }
  }

  const env = extractEnvFlags(flags);
  if (Object.keys(env).length > 0) {
    payload.env = env;
  }

  return payload;
};

const cmdAppCreate = async (api, _positional, flags) => {
  const help = flags.help;
  if (help) {
    logger.info(
      "ddc app create --name <name> --url <github-url> [--type <type>] [--hostId <id>] [--env NAME=VALUE ...]"
    );
    process.exit(1);
  }

  const payload = collectAppPayload(flags);

  if (!payload.name) {
    logger.error("ddc app create: --name is required");
    process.exit(1);
  }

  logger.info(`Creating app "${payload.name}"...`);
  const app = await api.createApp(payload);
  logger.info(`App created: ${app.id}`);

  output({
    id: app.id,
    name: app.name,
    status: app.status,
    type: app.type || "",
    hostId: app.hostId || "",
    hostname: app.hostname || "",
    repositoryUrl: app.repositoryUrl || ""
  });
};

const cmdAppModify = async (api, positional, flags) => {
  const appId = positional[0] || flags.appId;
  const help = flags.help;

  if (!appId || help) {
    logger.info(
      "ddc app modify <app-id> [--name <name>] [--url <github-url>] [--type <type>] [--env NAME=VALUE ...]"
    );
    process.exit(1);
  }

  const payload = collectAppPayload(flags);

  if (Object.keys(payload).length === 0) {
    throw new Error("No fields to update. Use --name, --url, --type, --env, etc.");
  }

  // Merge env with existing if updating env
  if (payload.env) {
    const existing = await api.getApp(appId);
    payload.env = { ...existing.env, ...payload.env };
  }

  logger.info(`Updating app ${appId}...`);
  const app = await api.updateApp(appId, payload);
  logger.info(`App updated: ${app.id}`);

  output({
    id: app.id,
    name: app.name,
    status: app.status,
    type: app.type || "",
    hostId: app.hostId || "",
    hostname: app.hostname || "",
    repositoryUrl: app.repositoryUrl || ""
  });
};

const cmdSshAdd = async (api, positional, flags) => {
  const privateKey = positional[0] || flags.key;
  const name = flags.name || "cli-added-key";

  if (!privateKey) {
    logger.error("ddc ssh add [<private-key-file>|--key <private-key-file>] [--name <name>]");
    process.exit(1);
  }

  if (!fs.existsSync(privateKey)) {
    logger.error(`SSH private key file ${privateKey} not found`);
    process.exit(1);
  }

  const content = fs.readFileSync(privateKey, "utf8");
  logger.info("Adding SSH key...");
  const result = await api.createSshKey({ name, privateKey: content });
  logger.info(`SSH key added: ${result.id}`);

  output({ id: result.id, name: result.name });
};

const cmdTemplateList = async (api, positional, flags) => {
  const search = positional[0] ?? flags.search;
  const templates = await api.getTemplates();
  const help = flags.help;
  const id = flags.id;

  if (help) {
    logger.info("ddc template list [--id <id>] [--search] <search>");
    process.exit(1);
  }

  output(
    templates
      .filter(t => !t.experimental)
      .filter(t => (id ? t.id === id : true))
      .filter(t =>
        search && search !== true
          ? t.name.toLowerCase().includes(search.toLowerCase()) ||
            t.tags?.some(tag => tag.toLowerCase().includes(search.toLowerCase())) ||
            t.intro?.toLowerCase().includes(search.toLowerCase())
          : true
      )
      .map(t => ({ id: t.id, name: t.name, tags: t.tags, intro: t.intro }))
  );
};

const cmdLogs = async (api, _positional, flags) => {
  if (flags.help) {
    logger.info(
      "ddc logs [--task <id>] [--app <id>] [--host <id>] [--type info,warn,error] [--limit <n>] [--follow]"
    );
    process.exit(1);
  }

  const params = {
    limit: flags.limit || 50,
    taskId: flags.task || flags.taskId,
    appId: flags.app || flags.appId,
    hostId: flags.host || flags.hostId,
    type: flags.type
  };

  const printLogs = logs => {
    if (jsonOutput) {
      output(logs);
      return;
    }
    for (const log of logs) {
      logger.log(
        `${new Date(log.createdAt).toISOString()}  ${String(log.type).padEnd(5)}  ${log.message}`
      );
    }
  };

  const follow = flags.follow === true || flags.f === true;

  if (!follow) {
    const { logs } = await api.getLogs(params);
    // API returns newest first; print in chronological order
    printLogs([...logs].reverse());
    return;
  }

  const seen = new Set();
  logger.info("Following logs (Ctrl+C to stop)...");
  while (true) {
    const { logs } = await api.getLogs(params);
    const fresh = [...logs].reverse().filter(log => !seen.has(log.id));
    for (const log of fresh) {
      seen.add(log.id);
    }
    printLogs(fresh);
    await sleep(2000);
  }
};

const cmdTask = async (api, positional, flags) => {
  const action = positional[0] || "list";

  if (action === "list" || action === "ls") {
    const status = flags.status || undefined;
    const tasks = await api.listTasks(status);
    output(
      tasks.map(t => ({
        id: t.id,
        type: t.type,
        status: t.status,
        app: t.app?.name || "",
        host: t.host?.name || "",
        createdAt: t.createdAt
      }))
    );
    return;
  }

  const taskId = positional[1] || flags.taskId;
  if (!taskId) {
    logger.error("ddc task <get|cancel> <task-id>");
    process.exit(1);
  }

  if (action === "get") {
    const task = await api.getTask(taskId);
    output({
      id: task.id,
      type: task.type,
      status: task.status,
      appId: task.appId || "",
      hostId: task.hostId || "",
      createdAt: task.createdAt,
      nextTaskId: task.nextTaskId || ""
    });
    return;
  }

  if (action === "cancel") {
    await api.cancelTask(taskId);
    logger.info(`Task ${taskId} cancelled.`);
    return;
  }

  logger.error("ddc task <list|get|cancel> [<task-id>]");
  process.exit(1);
};

const cmdHostService = async (api, positional, flags) => {
  const action = positional[0];
  const hostId = positional[1] || flags.hostId;

  if (!action || !hostId) {
    logger.error("ddc host service <list|get|add|remove> <host-id> [<type>|<service-id>]");
    process.exit(1);
  }

  if (action === "list" || action === "ls") {
    const services = await api.listServices(hostId);
    if (jsonOutput || flags.all) {
      output(services || []);
      return;
    }
    output(
      (services || []).map(s => ({
        id: s.id,
        type: s.type,
        status: s.status ?? ""
      }))
    );
    return;
  }

  if (action === "get") {
    const serviceId = positional[2] || flags.serviceId;
    if (!serviceId) {
      logger.error("ddc host service get <host-id> <service-id> [--all]");
      process.exit(1);
    }
    const service = await api.getService(hostId, serviceId);
    if (jsonOutput || flags.all) {
      output(service);
      return;
    }
    output({ id: service.id, type: service.type, status: service.status ?? "" });
    return;
  }

  if (action === "add") {
    const type = positional[2] || flags.type;
    if (!type) {
      logger.error("ddc host service add <host-id> <type>");
      process.exit(1);
    }
    logger.info(`Installing ${type} on host ${hostId}...`);
    const service = await api.createService(hostId, type);
    output({ id: service.id, type: service.type, status: service.status ?? "" });
    return;
  }

  if (action === "remove" || action === "rm") {
    const serviceId = positional[2] || flags.serviceId;
    if (!serviceId) {
      logger.error("ddc host service remove <host-id> <service-id>");
      process.exit(1);
    }
    await api.deleteService(hostId, serviceId);
    logger.info(`Service ${serviceId} removed from host ${hostId}.`);
    return;
  }

  logger.error("ddc host service <list|get|add|remove>");
  process.exit(1);
};

const cmdHostProvision = async (api, positional, flags) => {
  const timeout = parseInt(flags.timeout) || DEFAULT_TIMEOUT;
  const hostId = positional[0] || flags.hostId;
  if (!hostId) {
    logger.error(
      "ddc host provision <host-id> [--provider <p>] [--type <t>] [--region <r>] [--image <i>]"
    );
    process.exit(1);
  }

  const provider = normalizeProvider(flags.provider);
  if (provider) {
    const providerType = flags.type || PROVIDER_DEFAULTS[provider]?.type;
    const providerRegion = flags.region || PROVIDER_DEFAULTS[provider]?.region;
    const image = flags.image || PROVIDER_DEFAULTS[provider]?.image;
    if (!providerType || !providerRegion || !image) {
      throw new Error(
        `Incomplete config for ${provider}: type=${providerType}, region=${providerRegion}, image=${image}`
      );
    }
    logger.info(
      `Saving provision config (${provider} ${providerType} in ${providerRegion})...`
    );
    await api.saveProvision(hostId, { provider, providerType, providerRegion, image });
  }

  logger.info("Provisioning instance...");
  const task = await api.startProvision(hostId);
  await waitForTask(api, task.id, timeout);

  const host = await api.getHost(hostId);
  if (host.status !== "active") {
    throw new Error(`Host is not active. Status: ${host.status}`);
  }
  logger.info("Instance provisioned.");
  output({
    id: host.id,
    name: host.name,
    status: host.status,
    ip: host.ipAddress || "<not assigned>"
  });
};

const cmdHostDeprovision = async (api, positional, flags) => {
  const timeout = parseInt(flags.timeout) || DEFAULT_TIMEOUT;
  const hostId = positional[0] || flags.hostId;
  if (!hostId) {
    logger.error("ddc host deprovision <host-id> [--yes]");
    process.exit(1);
  }

  const host = await api.getHost(hostId);
  if (!flags.yes && !flags.force) {
    const ok = await confirm(
      `This will deprovision the server instance for host "${host.name || host.id}" (${host.ipAddress || "no IP"}) but keep the host in DollarDeploy.\nContinue?`
    );
    if (!ok) {
      logger.info("Aborted.");
      return;
    }
  }

  logger.info("Deprovisioning instance...");
  const task = await api.deprovisionHost(hostId, false);
  await waitForTask(api, task.id, timeout);
  logger.info(`Host ${hostId} deprovisioned (record kept).`);
};

const cmdHostTest = async (api, positional, flags) => {
  const timeout = parseInt(flags.timeout) || DEFAULT_TIMEOUT;
  const hostId = positional[0] || flags.hostId;
  if (!hostId) {
    logger.error("ddc host test <host-id>");
    process.exit(1);
  }

  logger.info(`Testing connection to host ${hostId}...`);
  const task = await api.testConnection(hostId);
  await waitForTask(api, task.id, timeout);
  logger.info(`Host ${hostId} connection OK.`);
};

const cmdAppRemove = async (api, positional, flags) => {
  const appId = positional[0] || flags.appId;
  if (!appId) {
    logger.error("ddc app remove <app-id> [--keep] [--yes]");
    process.exit(1);
  }

  const timeout = parseInt(flags.timeout) || DEFAULT_TIMEOUT;
  const deleteApp = flags.keep !== true;
  const app = await api.getApp(appId);

  if (!flags.yes && !flags.force) {
    const ok = await confirm(
      deleteApp
        ? `This will undeploy and permanently delete app "${app.name || app.id}".\nContinue?`
        : `This will undeploy app "${app.name || app.id}" but keep its configuration.\nContinue?`
    );
    if (!ok) {
      logger.info("Aborted.");
      return;
    }
  }

  logger.info(`Removing app ${appId}...`);
  const task = await api.removeApp(appId, { deleteApp });
  await waitForTask(api, task.id, timeout);
  logger.info(deleteApp ? `App ${appId} removed and deleted.` : `App ${appId} undeployed.`);
};

const cmdSshRemove = async (api, positional, flags) => {
  const keyId = positional[0] || flags.id;
  if (!keyId) {
    logger.error("ddc ssh remove <key-id> [--yes]");
    process.exit(1);
  }

  if (!flags.yes && !flags.force) {
    const ok = await confirm(`This will delete SSH key ${keyId}.\nContinue?`);
    if (!ok) {
      logger.info("Aborted.");
      return;
    }
  }

  await api.deleteSshKey(keyId);
  logger.info(`SSH key ${keyId} removed.`);
};

const cmdProvision = async (api, _positional, flags) => {
  const provider = normalizeProvider(flags.provider);
  if (!provider || flags.help) {
    logger.info(
      "ddc provision --provider <hetzner|do|verda> [--region <r>] [--type <t>] [--arch <a>] [--cpu <n>] [--memory <mb>] [--disk <gb>]"
    );
    logger.info(
      "Lists the regions, instance types and images available for a provider, so you know what to pass to `ddc host provision`."
    );
    process.exit(1);
  }

  const filters = {
    region: flags.region,
    type: flags.type,
    arch: flags.arch,
    cpu: flags.cpu,
    memory: flags.memory,
    disk: flags.disk
  };

  const config = await api.getProviderConfig(provider, filters);

  if (jsonOutput) {
    output(config);
    return;
  }

  logger.info(
    `Provider: ${config.id}  default region: ${config.defaultRegion}  default image: ${config.defaultImage}  default arch: ${config.defaultArch}`
  );

  logger.info("\nRegions:");
  output((config.regions || []).map(r => ({ id: r.id, label: r.label })));

  const hasFilters = Boolean(
    flags.region || flags.type || flags.arch || flags.cpu || flags.memory || flags.disk
  );
  const types = hasFilters ? config.types : config.available || config.types;

  logger.info(`\nInstance types${hasFilters ? " (matching filters)" : ""}:`);
  output(
    Object.entries(types || {}).map(([name, t]) => ({
      type: name,
      cpu: t.cpu,
      memoryGB: Math.round((t.memory / 1024) * 10) / 10,
      diskGB: t.disk,
      arch: (t.arch || config.arch || []).join(","),
      gpu: t.gpu ? `${t.gpu.count}x ${t.gpu.model}` : "",
      regions: t.regions ? t.regions.join(",") : "all"
    }))
  );

  logger.info("\nImages:");
  output((config.images || []).map(image => ({ image })));
};

// ─── Flag extraction helpers ─────────────────────────────────────────────────

const parseEnvValues = raw => {
  const env = {};
  if (!raw) {
    return env;
  }
  const items = Array.isArray(raw) ? raw : [raw];
  for (const item of items) {
    const eqIndex = item.indexOf("=");
    if (eqIndex === -1) {
      throw new Error(`Invalid env format: "${item}". Expected NAME=VALUE`);
    }
    env[item.slice(0, eqIndex)] = item.slice(eqIndex + 1);
  }
  return env;
};

const extractEnvFlags = flags => {
  const env = {};
  // --env NAME=VALUE format (can be specified multiple times)
  if (flags.env && flags.env !== true) {
    Object.assign(env, parseEnvValues(flags.env));
  }
  // --env:NAME value / --env.NAME value format
  for (const [key, value] of Object.entries(flags)) {
    if ((key.startsWith("env:") || key.startsWith("env.")) && value !== true) {
      env[key.slice(4)] = value;
    }
  }
  return env;
};

const extractAppFlags = flags => {
  const props = {};
  for (const [key, value] of Object.entries(flags)) {
    if (key.startsWith("set:") || key.startsWith("set.")) {
      props[key.slice(4)] = value;
    }
  }
  return props;
};

// ─── Help ────────────────────────────────────────────────────────────────────

const showHelp = () => {
  logger.info(`DollarDeploy CLI v${packageJson.version}

USAGE
  ddc <command> [options]

COMMANDS
  auth                          Authenticate with DollarDeploy
  host list                     List all hosts
  host get <id>                 Show a single host
  host create                   Create and provision a new host
  host provision <id>           Provision (or reprovision) a server for a host
  host deprovision <id>         Deprovision the server but keep the host record
  host test <id>                Test SSH connection to a host
  host destroy <id>             Deprovision and permanently delete a host
  host remove <id>              Remove a host from DollarDeploy (keeps the server)
  host prepare <id>             Prepare a host for deployment
  host service list <id>        List services installed on a host
  host service get <id> <sid>   Show a single service on a host
  host service add <id> <type>  Install a service on a host (e.g. docker)
  host service remove <id> <sid> Remove a service from a host
  app list                      List all apps
  app get <id>                  Show a single app
  app create                    Create a new app (see below for options)
  app modify <id>               Modify an existing app
  app deploy                    Deploy the git repo in the current folder
  app deploy --url <url>        Deploy new app from GitHub to a host
  app deploy --template <id>    Deploy template to a host
  app deploy --appId <id>       Redeploy existing app
  app deploy --url <url>        Redeploy existing app with the same repository URL
  app build <app-id>            Build an app (optionally deploy)
  app remove <id>               Undeploy an app (and delete it unless --keep)
  ssh list                      List all SSH keys
  ssh add <private-key-file>    Add an SSH key to your account
  ssh remove <id>               Delete an SSH key from your account
  template list                 List all templates
  task list                     List tasks (--status to filter)
  task get <id>                 Show a task
  task cancel <id>              Cancel a running task
  logs                          Show journal logs (--task/--app/--host/--follow)
  provision                     List available regions/types/images for a provider
  version                       Show CLI version
  help                          Show this help

GLOBAL OPTIONS
  --api-key <key>               API key (overrides stored auth and env var)
  --base-url <url>              API base URL (default: https://dollardeploy.com)
  --json                        Output results as JSON (machine-readable)
  --verbose, -v                 Enable verbose logging
  --help, -h                    Show help
  --version, -V                 Show version

AUTH & USER INFO
  ddc auth                      Interactive prompt to save API key
  ddc auth --api-key <key>      Save API key non-interactively
  ddc user                      Show user information

HOST CREATE OPTIONS
  --name <name>                 Host name
  --provider <provider>         Required: Cloud provider: hetzner, do, verda
  --type <type>                 Instance type (default: ${PROVIDER_DEFAULTS["hetzner"]?.type} for Hetzner)
  --region <region>             Provider region (default: ${PROVIDER_DEFAULTS["hetzner"]?.region} for Hetzner)
  --image <image>               OS image (default: ${PROVIDER_DEFAULTS["hetzner"]?.image} for Hetzner)
  --services <list>             Comma-separated services to install (default: docker)
  --skip-prepare                Skip host preparation step
  --timeout <ms>                Timeout in ms (default: 10 minutes)

HOST PROVISION OPTIONS
  --provider <provider>         Provider to save before provisioning (hetzner, do, verda)
  --type <type>                 Instance type (uses provider default if omitted)
  --region <region>             Provider region (uses provider default if omitted)
  --image <image>               OS image (uses provider default if omitted)
  --timeout <ms>                Timeout in ms (default: 10 minutes)
  Tip: run \`ddc provision --provider <p>\` to see valid types/regions/images.

PROVISION OPTIONS (ddc provision — list available options for a provider)
  --provider <provider>         Required: hetzner, do, verda
  --region <region>             Filter instance types available in a region
  --type <type>                 Show details for a specific instance type
  --arch <arch>                 Filter by architecture (e.g. arm64, amd64)
  --cpu <n>                     Filter to types with at least N vCPUs
  --memory <mb>                 Filter to types with at least N MB memory
  --disk <gb>                   Filter to types with at least N GB disk

HOST DESTROY / REMOVE / DEPROVISION OPTIONS
  --yes, --force                DANGEROUS: Skip confirmation prompt, remove host and all data permanently

APP REMOVE OPTIONS
  --keep                        Keep the app configuration (undeploy only)
  --yes, --force                Skip confirmation prompt

TASK OPTIONS
  --status <status>             Filter task list by status

LOGS OPTIONS
  --task <id>                   Filter logs by task ID
  --app <id>                    Filter logs by app ID
  --host <id>                   Filter logs by host ID
  --type <types>                Log types (comma separated: info,warn,error,health,log,ai)
  --limit <n>                   Number of records (default: 50)
  --follow, -f                  Continuously poll for new logs

APP DEPLOY OPTIONS
  (no url/template/appId)       Deploy the git repo in the current folder:
                                detects the remote URL and branch, warns on
                                uncommitted/unpushed changes, reads env from
                                .env.production/.env.prod/.env.local and treats
                                .env.example keys as placeholders to fill at
                                dollardeploy.com, then shows a confirmation
                                overview before deploying (env values hidden).
  --path <dir>                  Folder to deploy (default: current directory)
  --yes                         Skip the local-deploy confirmation prompt
  --url <github-url>            Deploy from a GitHub repository
  --template <id>               Deploy from a template
  --appId <id>                  Redeploy an existing app
  --hostId <id>                 Deploy to an existing host ID
  --create-host                 Create a new host for deployment
  --name <name>                 App name
  --sourceBranch <branch>       Branch to deploy from (default: current branch)
  --env NAME=VALUE              Set environment variable (can be specified multiple times)
  --set:<key> <value>           Set app property
  --provider <provider>         Provider for --create-host (default: hetzner)
  --type <type>                 Instance type for --create-host
  --region <region>             Region for --create-host
  --services <list>             Services for --create-host (default: docker)
  --timeout <ms>                Timeout in ms (default: 10 minutes)

APP CREATE / MODIFY OPTIONS
  --name <name>                 App name (required for create)
  --url <github-url>            GitHub repository URL
  --type <type>                 App type: next, react, react-static, docker-compose, native, java, php
  --hostId <id>                 Host to assign the app to
  --hostname <hostname>         Hostname for the app
  --mainPort <port>             Main port the app listens on
  --sourcePath <path>           Source path within the repository
  --sourceBranch <branch>       Branch to deploy from
  --startScript <script>        Start script (e.g. "start")
  --startCmd <cmd>              Start command (e.g. "node server.js")
  --buildScript <script>        Build script (e.g. "build")
  --buildCmd <cmd>              Build command (e.g. "npm run build")
  --installCmd <cmd>            Install command (e.g. "npm install")
  --buildPath <path>            Build output path (for static builds, defaults to "dist")
  --webPath <path>              Web root path (for php apps, defaults to ".")
  --dockerComposeFile <file>    Docker Compose file path (default: docker-compose.yml)
  --preStartCmd <cmd>           Command to run before start
  --postStartCmd <cmd>          Command to run after start
  --description <text>          App description
  --env NAME=VALUE              Set environment variable (can be specified multiple times)

APP BUILD OPTIONS
  --deploy                      Deploy after building
  --timeout <ms>                Timeout in ms (default: 10 minutes)

TEMPLATE OPTIONS
  --id <id>                     Template ID
  [--search] <search>           Search templates by name or tags

SSH OPTIONS
  --name <name>                 Key name (default: cli-added-key)

EXAMPLES
  # Authenticate
  ddc auth

  # List all hosts
  ddc host list --json

  # Create a host on Hetzner
  ddc host create --name my-server --provider hetzner

  # List templates by name or tag
  ddc template list cms

  # Create an app
  ddc app create --name myapp --url https://github.com/org/repo --type next --env DATABASE_URL=postgres://localhost/db --env NODE_ENV=production

  # Modify an existing app
  ddc app modify <app-id> --name new-name --env API_KEY=secret

  # Deploy the git repo in the current folder (detects repo, env, shows overview)
  ddc deploy

  # Deploy the current folder without the confirmation prompt (CI-friendly)
  ddc deploy --yes

  # Deploy from GitHub to an existing host
  ddc app deploy --url https://github.com/org/repo --hostId <host-id>

  # Deploy from GitHub with automatically provisioned host
  ddc app deploy --url https://github.com/org/repo --create-host --provider hetzner

  # Deploy from a template
  ddc app deploy --template ghost-cms --hostId <host-id>

  # Redeploy an existing app
  ddc app deploy --appId <app-id>

  # Deploy a template
  ddc app deploy --template nextjs-boilerplate --hostId <host-id>

  # Build and deploy
  ddc app build <app-id> --deploy

  # Add SSH key from local file. DollarDeploy uses your private key to provision hosts on your behalf.
  ddc ssh add \${HOME}/.ssh/id_rsa [--name <name>]

  # List all SSH keys
  ddc ssh list [--name <name>]

ENVIRONMENT VARIABLES
  DOLLARDEPLOY_API_KEY          API key (can also use ddc auth or --api-key)
  DOLLARDEPLOY_BASE_URL         API base URL (default: https://dollardeploy.com)

DOCUMENTATION
  CLI docs: https://docs.dollardeploy.com/cli
  API docs: https://dollardeploy.com/apidocs
  Use DollarDeploy in AI agents: https://docs.dollardeploy.com/mcp/
  Install Claude Code skill: https://github.com/dollardeploy/agents/
`);
};

// ─── Main ────────────────────────────────────────────────────────────────────

const main = async () => {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  // Global flags
  if (flags.verbose) {
    process.env.NEXT_PUBLIC_LOG_VERBOSE = "1";
  }

  jsonOutput = flags.json === true;

  if (flags.version) {
    logger.info(`ddc v${packageJson.version}`);
    process.exit(0);
  }

  const command = positional[0];
  const subcommand = positional[1];

  if (!command) {
    showHelp();
    process.exit(flags.help ? 0 : 1);
  }

  if (command === "version") {
    logger.info(`ddc v${packageJson.version}`);
    process.exit(0);
  }

  if (command === "help") {
    showHelp();
    process.exit(0);
  }

  // Auth doesn't need an API key
  if (command === "auth") {
    await cmdAuth(null, positional.slice(1), flags);
    return;
  }

  // All other commands require auth
  const auth = {
    apiKey: flags["api-key"] || flags.apiKey,
    baseUrl: flags["base-url"] || flags.baseUrl
  };

  if (!auth.apiKey) {
    Object.assign(auth, findAuth(auth.baseUrl));
  }

  try {
    const api = createApiClient(auth);

    if (command === "user") {
      await cmdUser(api);
    } else if (command === "host") {
      if (subcommand === "prepare") {
        await cmdHostPrepare(api, positional.slice(2), flags);
      } else if (subcommand === "list" || subcommand === "ls") {
        await cmdHostList(api, positional.slice(2), flags);
      } else if (subcommand === "get") {
        await cmdHostGet(api, positional.slice(2), flags);
      } else if (subcommand === "create") {
        await cmdHostCreate(api, positional.slice(2), flags);
      } else if (subcommand === "provision") {
        await cmdHostProvision(api, positional.slice(2), flags);
      } else if (subcommand === "deprovision") {
        await cmdHostDeprovision(api, positional.slice(2), flags);
      } else if (subcommand === "test") {
        await cmdHostTest(api, positional.slice(2), flags);
      } else if (subcommand === "service" || subcommand === "services") {
        await cmdHostService(api, positional.slice(2), flags);
      } else if (subcommand === "destroy") {
        await cmdHostDestroy(api, positional.slice(2), flags);
      } else if (subcommand === "remove" || subcommand === "rm") {
        await cmdHostRemove(api, positional.slice(2), flags);
      } else {
        logger.error(
          `ddc host <prepare|list|get|create|provision|deprovision|test|service|destroy|remove>`
        );
        process.exit(1);
      }
    } else if (command === "app") {
      if (subcommand === "list" || subcommand === "ls") {
        await cmdAppList(api, positional.slice(2), flags);
      } else if (subcommand === "get") {
        await cmdAppGet(api, positional.slice(2), flags);
      } else if (subcommand === "create") {
        await cmdAppCreate(api, positional.slice(2), flags);
      } else if (subcommand === "modify") {
        await cmdAppModify(api, positional.slice(2), flags);
      } else if (subcommand === "build") {
        await cmdAppBuild(api, positional.slice(2), flags);
      } else if (subcommand === "deploy") {
        await cmdAppDeploy(api, positional.slice(2), flags);
      } else if (subcommand === "remove" || subcommand === "rm") {
        await cmdAppRemove(api, positional.slice(2), flags);
      } else {
        logger.error(`ddc app <list|get|create|modify|build|deploy|remove>`);
        process.exit(1);
      }
    } else if (command === "deploy") {
      await cmdAppDeploy(api, positional.slice(1), flags);
    } else if (command === "build") {
      await cmdAppBuild(api, positional.slice(1), flags);
    } else if (command === "ssh") {
      if (subcommand === "list" || subcommand === "ls") {
        await cmdSshList(api, positional.slice(2), flags);
      } else if (subcommand === "add") {
        await cmdSshAdd(api, positional.slice(2), flags);
      } else if (subcommand === "remove" || subcommand === "rm") {
        await cmdSshRemove(api, positional.slice(2), flags);
      } else {
        logger.error(`ddc ssh <list|add|remove>`);
        process.exit(1);
      }
    } else if (command === "template") {
      if (subcommand === "list" || subcommand === "ls") {
        await cmdTemplateList(api, positional.slice(2), flags);
      } else {
        logger.error(`ddc template <list>`);
        process.exit(1);
      }
    } else if (command === "task") {
      await cmdTask(api, positional.slice(1), flags);
    } else if (command === "logs") {
      await cmdLogs(api, positional.slice(1), flags);
    } else if (command === "provision") {
      await cmdProvision(api, positional.slice(1), flags);
    } else {
      logger.info(
        `ddc <auth|user|host|app|deploy|build|ssh|template|task|logs|provision|version|help>`
      );
      process.exit(1);
    }
  } catch (error) {
    if (jsonOutput) {
      logger.warn(JSON.stringify({ error: error.message }, null, 2));
    } else {
      logger.warn(`Error: ${error.message}`, error.stack);
    }
    process.exit(1);
  }
};

if (require.main === module) {
  main();
}

module.exports = {
  createApiClient,
  waitForTask,
  checkUrl
};
