// Downloadable packages generated on the fly: the Local Bridge CLI (zip) and a VS Code extension (.vsix).
import { zipSync, strToU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rootPkg = (root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const read = (root, rel) => readFileSync(join(root, rel));

export function bridgeZip(root, origin) {
  const deps = rootPkg(root).dependencies; const pkg = { name: 'hackconnect-bridge', version: '1.0.0', description: 'HackConnect Local Bridge: share a local folder with your workspace', type: 'module', bin: { hackconnect: 'bridge/cli.mjs' }, engines: { node: '>=20' }, license: 'MIT', dependencies: { ws: deps.ws, yjs: deps.yjs, 'y-protocols': deps['y-protocols'], lib0: deps.lib0 } };
  const readme = `# HackConnect Local Bridge

Share a folder on your computer with your HackConnect workspace, live, in both directions.

## Install (needs Node.js 20 or newer, free from nodejs.org)
\`\`\`
unzip hackconnect-bridge.zip -d hackconnect-bridge
cd hackconnect-bridge
npm install
npm install -g .
\`\`\`

## Use
\`\`\`
hackconnect login --server ${origin}
hackconnect workspaces
hackconnect share ./my-project --workspace <workspace id>
hackconnect expose 3000 --workspace <workspace id>      # needs the free cloudflared tool
hackconnect assistant --origin ${origin}                # use your signed-in Claude Code / Codex in the assistant
\`\`\`

Only the folder you share leaves your machine. .env files, keys, node_modules and anything that looks like a secret are never uploaded. Press Ctrl+C to stop sharing. Agent conversations are never captured.
`;
  return Buffer.from(zipSync({ 'package.json': strToU8(JSON.stringify(pkg, null, 2)), 'README.md': strToU8(readme), 'bridge/cli.mjs': read(root, 'bridge/cli.mjs'), 'bridge/sync.mjs': read(root, 'bridge/sync.mjs'), 'bridge/tunnel.mjs': read(root, 'bridge/tunnel.mjs'), 'bridge/agent-bridge.mjs': read(root, 'bridge/agent-bridge.mjs'), 'lib/secrets.mjs': read(root, 'lib/secrets.mjs') }, { level: 6 }));
}

const EXTENSION_JS = `// HackConnect for VS Code: share the open folder with a HackConnect workspace using the Local Bridge CLI.
const vscode = require('vscode');

function serverUrl() { return vscode.workspace.getConfiguration('hackconnect').get('serverUrl') || 'http://localhost:4173'; }
function runInTerminal(name, command) { const terminal = vscode.window.createTerminal({ name }); terminal.show(); terminal.sendText(command); return terminal; }
const quote = (value) => '"' + String(value).replace(/"/g, '') + '"';

function activate(context) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50); status.text = '$(plug) HackConnect'; status.tooltip = 'Share this folder with your HackConnect workspace'; status.command = 'hackconnect.share'; status.show(); context.subscriptions.push(status);
  context.subscriptions.push(
    vscode.commands.registerCommand('hackconnect.login', () => runInTerminal('HackConnect login', 'hackconnect login --server ' + quote(serverUrl()))),
    vscode.commands.registerCommand('hackconnect.share', async () => {
      const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      if (!folder) { vscode.window.showWarningMessage('Open a folder first, then share it with HackConnect.'); return; }
      const remembered = context.workspaceState.get('hackconnect.workspaceId') || '';
      const id = await vscode.window.showInputBox({ title: 'HackConnect workspace id', prompt: 'Paste the workspace id (run "hackconnect workspaces" in a terminal to list yours)', value: remembered, ignoreFocusOut: true });
      if (!id) return; await context.workspaceState.update('hackconnect.workspaceId', id.trim());
      const agent = vscode.workspace.getConfiguration('hackconnect').get('agentName') || '';
      runInTerminal('HackConnect share', 'hackconnect share ' + quote(folder.uri.fsPath) + ' --workspace ' + quote(id.trim()) + ' --server ' + quote(serverUrl()) + (agent ? ' --agent ' + quote(agent) : ''));
    }),
    vscode.commands.registerCommand('hackconnect.openWorkspace', () => vscode.env.openExternal(vscode.Uri.parse(serverUrl()))),
    vscode.commands.registerCommand('hackconnect.connectAgent', async () => {
      const choice = await vscode.window.showInformationMessage('To let Claude Code, Codex or Cursor edit a shared workspace, create an access token in HackConnect (Live workspace > Connect an agent) and run the command it shows.', 'Open HackConnect');
      if (choice) vscode.env.openExternal(vscode.Uri.parse(serverUrl()));
    })
  );
}
function deactivate() {}
module.exports = { activate, deactivate };
`;

export function vsix(origin) {
  const manifest = { name: 'hackconnect', displayName: 'HackConnect', description: 'Share this folder with your HackConnect workspace, live.', version: '0.1.0', publisher: 'hackconnect', license: 'MIT', engines: { vscode: '^1.80.0' }, categories: ['Other'], main: './extension.js', activationEvents: ['onStartupFinished'],
    contributes: { commands: [{ command: 'hackconnect.login', title: 'HackConnect: Sign in' }, { command: 'hackconnect.share', title: 'HackConnect: Share this folder' }, { command: 'hackconnect.openWorkspace', title: 'HackConnect: Open in browser' }, { command: 'hackconnect.connectAgent', title: 'HackConnect: Connect an AI agent' }], configuration: { title: 'HackConnect', properties: { 'hackconnect.serverUrl': { type: 'string', default: origin, description: 'Address of your HackConnect server' }, 'hackconnect.agentName': { type: 'string', default: '', description: 'Tag edits from this window as agent-authored (for example claude-code). Leave empty for your own edits.' } } } } };
  const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="hackconnect" Version="0.1.0" Publisher="hackconnect" />
    <DisplayName>HackConnect</DisplayName>
    <Description xml:space="preserve">Share this folder with your HackConnect workspace, live.</Description>
    <Tags>collaboration,live share,hackathon</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.80.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
  </Assets>
</PackageManifest>
`;
  const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".md" ContentType="text/markdown" /><Default Extension=".vsixmanifest" ContentType="text/xml" /></Types>
`;
  const readme = `# HackConnect for VS Code

Share the folder you have open with a HackConnect workspace, live and in both directions.

1. Install the Local Bridge from the HackConnect site (Downloads) so the \`hackconnect\` command exists.
2. Run **HackConnect: Sign in** once.
3. Run **HackConnect: Share this folder** and paste your workspace id.

Only the folder you choose is shared; secrets and node_modules are never uploaded. Set \`hackconnect.agentName\` (for example \`claude-code\`) to tag edits from this window as agent-authored.
`;
  return Buffer.from(zipSync({ '[Content_Types].xml': strToU8(contentTypes), 'extension.vsixmanifest': strToU8(vsixManifest), 'extension/package.json': strToU8(JSON.stringify(manifest, null, 2)), 'extension/extension.js': strToU8(EXTENSION_JS), 'extension/readme.md': strToU8(readme) }, { level: 6 }));
}

/** "Assistant launcher": a tiny download (agent-bridge.mjs + double-click start scripts, origin baked in) that lets the assistant use the
 *  user's own signed-in Claude Code / Codex. Only needs Node.js; no npm install. */
export function assistantZip(root, origin, tool = 'claude') {
  const t = tool === 'codex' ? 'codex' : 'claude'; const label = t === 'codex' ? 'Codex' : 'Claude Code'; const pkgName = t === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
  const cmd = ['@echo off', 'title HackConnect Assistant', 'cd /d "%~dp0"', 'where node >nul 2>nul', 'if errorlevel 1 (', '  echo Node.js is needed first. Opening the download page...', '  start https://nodejs.org/en/download', '  echo Install Node.js, then double-click this file again.', '  pause', '  exit /b 1', ')',
    `where ${t} >nul 2>nul`, 'if errorlevel 1 (', `  echo ${label} is not installed yet.`, `  choice /c YN /m "Install ${label} now"`, '  if errorlevel 2 goto run', `  call npm install -g ${pkgName}`, `  echo.`, `  echo Installed. Go back to HackConnect and press "Sign in".`, ')', ':run', 'echo.', 'echo HackConnect Assistant is running. Keep this window open while you use the assistant.', `node agent-bridge.mjs --origin ${origin}`, 'pause', ''].join('\r\n');
  const sh = ['#!/bin/sh', 'cd "$(dirname "$0")"', 'if ! command -v node >/dev/null 2>&1; then echo "Node.js is needed first: https://nodejs.org/en/download"; printf "Press Enter to close"; read _; exit 1; fi',
    `if ! command -v ${t} >/dev/null 2>&1; then echo "${label} is not installed yet."; printf "Install ${label} now? [y/N] "; read a; case "$a" in y|Y) npm install -g ${pkgName};; esac; fi`,
    'echo "HackConnect Assistant is running. Keep this window open while you use the assistant."', `node agent-bridge.mjs --origin ${origin}`, ''].join('\n');
  const readme = `HackConnect Assistant launcher (${label})

1. Windows: double-click  start-assistant.cmd
   Mac:     double-click  start-assistant.command   (first time: right-click > Open)
   Linux:   run           sh start-assistant.sh
2. Keep the window open.
3. Go back to HackConnect, open the Assistant and press "Sign in with ${t === 'codex' ? 'Codex' : 'Claude'}".

Your password never goes to HackConnect. You sign in with ${label}'s own page, and your questions are answered by ${label} on this computer.
Needs Node.js (free, nodejs.org). To stop: close the window.
`;
  const x = (data, mode) => [strToU8(data), { os: 3, attrs: (0o100000 | mode) << 16 }];
  return Buffer.from(zipSync({ 'README.txt': strToU8(readme), 'agent-bridge.mjs': read(root, 'bridge/agent-bridge.mjs'), 'start-assistant.cmd': strToU8(cmd), 'start-assistant.command': x(sh, 0o755), 'start-assistant.sh': x(sh, 0o755) }, { level: 6 }));
}
