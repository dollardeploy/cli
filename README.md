# @dollardeploy/cli

> Deploy apps to your own servers from the command line. Zero DevOps, full control.

[![npm version](https://img.shields.io/npm/v/@dollardeploy/cli.svg)](https://www.npmjs.com/package/@dollardeploy/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

The **DollarDeploy CLI** (`ddc`) lets you manage servers, deploy applications, and control your infrastructure — all from the terminal. Designed for CI/CD pipelines, AI agents, and developers who prefer the command line.

## Installation

```bash
npm install -g @dollardeploy/cli
```

Or use npx:

```bash
npx @dollardeploy/cli help
```

## Quick Start

### 1. Get an API Key

1. Sign in at [dollardeploy.com](https://dollardeploy.com)
2. Go to **Settings** → **API Keys**
3. Click **Create API Key** and copy it

### 2. Authenticate

```bash
# Interactive
ddc auth

# Non-interactive
ddc auth --api-key <your-api-key>
```

Your API key is saved to `~/.dollardeploy/auth` and can be overridden with the `--api-key` flag or `DOLLARDEPLOY_API_KEY` environment variable.

### 3. Deploy

```bash
# Deploy from GitHub to an existing host
ddc deploy --url https://github.com/your-org/your-app --hostId <host-id>

# Deploy and auto-create a host
ddc deploy --url https://github.com/your-org/your-app --create-host

# Deploy from a template
ddc deploy --template nextjs-boilerplate --hostId <host-id>
```

## Commands

### `ddc auth`

Save your API key for future commands.

```bash
ddc auth                        # Interactive prompt
ddc auth --api-key <key>        # Non-interactive
```

API key resolution order: `--api-key` flag > `DOLLARDEPLOY_API_KEY` env var > `~/.dollardeploy/auth` file.

### `ddc user`

Show current user information.

```bash
ddc user
```

### `ddc host list`

List all hosts in your account.

```bash
ddc host list
ddc host list --status active
ddc host list --json              # Machine-readable output
```

### `ddc host create`

Create and provision a new host. You need to set the integration with your cloud provider first in the DollarDeploy Settings => Integrations.

```bash
# Just create a host entry
ddc host create --name my-server

# Create a host on Hetzner
ddc host create --name my-server --provider hetzner --type cpx31 --region fsn1

# Create a host on DigitalOcean
ddc host create --name my-server --provider do --type s-2vcpu-4gb --region fra1

# Create a host on Verda Cloud (formerly DataCrunch)
ddc host create --name my-server --provider verda --type CPU.4V.16G --region FIN-01

# Create a host with Docker and PostgreSQL
ddc host create --name my-server --services docker,postgres
```

| Option             | Description                                            | Default         |
| ------------------ | ------------------------------------------------------ | --------------- |
| `--name`           | Host name                                              | auto-generated  |
| `--provider`       | Cloud provider: `hetzner`, `do`, `datacrunch`          | `hetzner`       |
| `--type`           | Instance type                                          | `cax11`         |
| `--region`         | Provider region                                        | `fsn1`          |
| `--image`          | OS image                                               | `ubuntu-24.04`  |
| `--services`       | Comma-separated services to install                    | `docker`        |
| `--skip-prepare`   | Skip host preparation step                             | `false`         |
| `--timeout`        | Timeout in milliseconds                                | `600000`        |

### `ddc host prepare <id>`

Prepare a host for deployment. This will install the necessary services and configure the host for deployment.

```bash
ddc host prepare <host-id>
```

### `ddc host destroy <id>`

Deprovision and permanently delete a host. This removes the VM from your cloud provider.

```bash
ddc host destroy <host-id>
ddc host destroy <host-id> --yes    # DANGEROUS: Skip confirmation
```

### `ddc host remove <id>`

Remove a host from DollarDeploy without deprovisioning. The server continues running but is no longer managed.

```bash
ddc host remove <host-id>
ddc host remove <host-id> --yes     # DANGEROUS: Skip confirmation
```

### `ddc deploy`

Deploy an application to a host. Supports GitHub repos, templates, and redeployment of existing apps.

Also available as `ddc app deploy`.

```bash
# Deploy from GitHub (will redeploy existing app if URL matches)
ddc deploy --url https://github.com/org/repo --hostId <host-id>

# Deploy with a new host
ddc deploy --url https://github.com/org/repo --create-host

# Deploy a template
ddc deploy --template twenty-crm --hostId <host-id>

# Redeploy an existing app
ddc deploy --appId <app-id>

# Deploy with environment variables
ddc deploy --url https://github.com/org/repo --hostId <host-id> --env:DATABASE_URL postgres://...

# Deploy with app property overrides
ddc deploy --url https://github.com/org/repo --hostId <host-id> --set:mainPort 8080
```

The deploy command is smart about redeployment — if you deploy the same GitHub URL to the same host, it will detect the existing app and redeploy it instead of creating a duplicate.

| Option             | Description                                            |
| ------------------ | ------------------------------------------------------ |
| `--url`            | GitHub repository URL                                  |
| `--template`       | Template ID to deploy                                  |
| `--appId`          | Existing app ID to redeploy                            |
| `--hostId`         | Target host ID                                         |
| `--create-host`    | Create a new host for deployment                       |
| `--name`           | App name                                               |
| `--env NAME=VALUE` | Set environment variable                               |
| `--set:<key>`      | Set app property (mainPort, env:PROPERTY_NAME, etc.)   |
| `--provider`       | Provider for `--create-host`                           |
| `--type`           | Instance type for `--create-host`                      |
| `--region`         | Region for `--create-host`                             |
| `--services`       | Services for `--create-host`                           |
| `--timeout`        | Timeout in milliseconds (default: 600000)              |

### `ddc build`

Build an app, optionally deploying it after build.

Also available as `ddc app build`.

```bash
ddc build <app-id>
ddc build <app-id> --deploy
```

| Option      | Description                               |
| ----------- | ----------------------------------------- |
| `--deploy`  | Deploy after building                     |
| `--timeout` | Timeout in milliseconds (default: 600000) |

### `ddc app list`

List all apps in your account.

```bash
ddc app list
ddc app list --json
```

### `ddc template list`

List all templates.

```bash
ddc template list
ddc template list <search>
ddc template list --json
```

### `ddc ssh add`

Add an SSH public key to your DollarDeploy account.

```bash
ddc ssh add ${HOME}/.ssh/id_rsa --name my-key
```

| Option    | Description                        |
| --------- | ---------------------------------- |
| `--name`  | Key name (default: cli-added-key)  |

### `ddc ssh list`

List all SSH keys in your account.

```bash
ddc ssh list
ddc ssh list --name my-key
```

## Global Options

| Option              | Description                                        |
| ------------------- | -------------------------------------------------- |
| `--api-key <key>`   | API key (overrides stored auth and env var)         |
| `--base-url <url>`  | API base URL (default: `https://dollardeploy.com`) |
| `--json`            | Output as JSON (machine-readable)                  |
| `--verbose`, `-v`   | Enable verbose logging                             |
| `--help`, `-h`      | Show help                                          |
| `--version`, `-V`   | Show version                                       |

## JSON Output (AI Agent Friendly)

All commands support `--json` for structured, machine-readable output:

```bash
ddc host list --json
ddc deploy --url https://github.com/org/repo --hostId <id> --json
```

JSON output goes to stdout, while progress/status messages go to stderr, making it easy to pipe results into other tools.

## Environment Variables

| Variable                | Description  | Default                    |
| ----------------------- | ------------ | -------------------------- |
| `DOLLARDEPLOY_API_KEY`  | Your API key | —                          |
| `DOLLARDEPLOY_BASE_URL` | API base URL | `https://dollardeploy.com` |

## Provider Defaults

| Provider     | Type           | Region   | Image          |
| ------------ | -------------- | -------- | -------------- |
| Hetzner      | `cax11`        | `fsn1`   | `ubuntu-24.04` |
| DigitalOcean | `s-2vcpu-4gb`  | `fra1`   | `ubuntu-24-04` |
| Verda Cloud  | `CPU.4V.16G`   | `FIN-01` | `ubuntu-24.04` |

## CI/CD Integration

### GitHub Actions

```yaml
name: Deploy my app

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Deploy
        env:
          DOLLARDEPLOY_API_KEY: ${{ secrets.DOLLARDEPLOY_API_KEY }}
        run: |
          npm install -g @dollardeploy/cli
          ddc deploy --url ${{ github.server_url }}/${{ github.repository }}
```

## Programmatic Usage

Use the CLI as a Node.js library:

```javascript
const { createApiClient, waitForTask, checkUrl } = require("@dollardeploy/cli");

const api = createApiClient("https://dollardeploy.com", process.env.DOLLARDEPLOY_API_KEY);

// List all hosts
const hosts = await api.listHosts();

// Create and provision a host
const host = await api.createHost("my-server");
await api.saveProvision(host.id, {
  provider: "hetzner",
  providerType: "cax11",
  providerRegion: "fsn1",
  image: "ubuntu-24.04"
});
const task = await api.startProvision(host.id);
await waitForTask(api, task.id);

// Deploy an app
const app = await api.createApp({
  repositoryUrl: "https://github.com/org/repo",
  hostId: host.id,
  name: "my-app"
});
const buildTask = await api.buildApp(app.id, { deploy: true });
await waitForTask(api, buildTask.id);

// Verify deployment
await checkUrl(`https://${app.hostname}`);
```

### API Client Methods

#### Hosts

| Method                   | Description                  |
| ------------------------ | ---------------------------- |
| `createHost(name?)`      | Create a new host            |
| `getHost(id)`            | Get host details             |
| `listHosts(status?)`     | List all hosts               |
| `updateHost(id, data)`   | Update host configuration    |
| `deleteHost(id)`         | Delete a host                |
| `testConnection(hostId)` | Test SSH connection          |
| `prepareHost(hostId)`    | Prepare host for deployments |

#### Provisioning

| Method                        | Description             |
| ----------------------------- | ----------------------- |
| `getProvision(hostId)`        | Get provision config    |
| `saveProvision(hostId, data)` | Save provision config   |
| `provisionHost(hostId)`       | Start provisioning      |
| `startProvision(hostId)`      | Alias for provisionHost |
| `deprovisionHost(hostId)`     | Deprovision and delete  |

#### Services

| Method                        | Description             |
| ----------------------------- | ----------------------- |
| `listServices(hostId)`        | List installed services |
| `createService(hostId, type)` | Install a service       |

#### Apps

| Method                    | Description                      |
| ------------------------- | -------------------------------- |
| `createApp(config)`       | Create a new app                 |
| `getApp(id)`              | Get app details                  |
| `listApps()`              | List all apps                    |
| `updateApp(id, data)`     | Update app configuration         |
| `suggestApp(app)`         | Get AI configuration suggestions |
| `buildApp(id, options?)`  | Build app (optionally deploy)    |
| `deployApp(id)`           | Deploy built app                 |
| `deleteApp(id)`           | Delete an app                    |
| `removeApp(id, options?)` | Remove app from host             |

#### SSH Keys

| Method                   | Description        |
| ------------------------ | ------------------ |
| `listSshKeys()`          | List all SSH keys  |
| `createSshKey(data)`     | Create an SSH key  |

#### Templates

| Method                   | Description          |
| ------------------------ | -------------------- |
| `getTemplates()`         | List all templates   |
| `getTemplate(id)`        | Get template details |
| `launchTemplate(config)` | Launch from template |

#### Tasks

| Method               | Description     |
| -------------------- | --------------- |
| `getTask(id)`        | Get task status |
| `getTaskJournal(id)` | Get task logs   |

#### User

| Method       | Description            |
| ------------ | ---------------------- |
| `getUser()`  | Get current user info  |

## Links

- **Website**: [dollardeploy.com](https://dollardeploy.com)
- **CLI Docs**: [docs.dollardeploy.com](https://docs.dollardeploy.com/cli)
- **API Reference**: [dollardeploy.com/apidocs](https://dollardeploy.com/apidocs)
- **GitHub**: [github.com/dollardeploy](https://github.com/dollardeploy)
- **Discord**: [Join our community](https://dollardeploy.com/discord)

## License

CLI is licensed under MIT © [DollarDeploy](https://dollardeploy.com)
