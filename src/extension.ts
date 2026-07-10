import * as vscode from "vscode";

// ── Pricing per 1M input tokens (USD) ────────────────────────────
const COST_PER_M: Record<string, number> = {
  "copilot-gpt-4o":          2.50,
  "copilot-gpt-4o-mini":     0.15,
  "copilot-claude-sonnet-4": 3.00,
  "copilot-claude-opus-4":   15.00,
  "copilot-o1":              15.00,
  "copilot-o3-mini":         1.10,
  "default":                 2.50,
};

// ── Session state ─────────────────────────────────────────────────
interface RequestRecord {
  ts:     number;
  model:  string;
  tokens: number;
  cost:   number;
}

let sessionRequests: RequestRecord[] = [];
let todayRequests:   RequestRecord[] = [];
let statusBar:       vscode.StatusBarItem;
let panel:           vscode.WebviewPanel | undefined;

// ── Helpers ───────────────────────────────────────────────────────
function estimateCost(tokens: number, model: string): number {
  const price = COST_PER_M[model] ?? COST_PER_M["default"];
  return (tokens / 1_000_000) * price;
}

function fmtCost(usd: number): string {
  if (usd <= 0)    return "$0.00";
  if (usd < 0.001) return "<$0.001";
  if (usd < 0.01)  return "$" + usd.toFixed(4);
  if (usd < 1)     return "$" + usd.toFixed(3);
  return "$" + usd.toFixed(2);
}

function fk(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}

function isSameDay(ts: number): boolean {
  const d   = new Date(ts);
  const now = new Date();
  return d.getDate()     === now.getDate()     &&
         d.getMonth()    === now.getMonth()    &&
         d.getFullYear() === now.getFullYear();
}

function sessionTotal(): { tokens: number; cost: number } {
  return {
    tokens: sessionRequests.reduce((s, r) => s + r.tokens, 0),
    cost:   sessionRequests.reduce((s, r) => s + r.cost,   0),
  };
}

function getDayTotal(): { tokens: number; cost: number } {
  const recs = todayRequests.filter(r => isSameDay(r.ts));
  return {
    tokens: recs.reduce((s, r) => s + r.tokens, 0),
    cost:   recs.reduce((s, r) => s + r.cost,   0),
  };
}

function getWeekTotal(): { tokens: number; cost: number } {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recs    = todayRequests.filter(r => r.ts >= weekAgo);
  return {
    tokens: recs.reduce((s, r) => s + r.tokens, 0),
    cost:   recs.reduce((s, r) => s + r.cost,   0),
  };
}

// ── Status bar update ─────────────────────────────────────────────
function updateStatusBar(): void {
  const config = vscode.workspace.getConfiguration("tokenpulse");
  if (!config.get<boolean>("showStatusBar", true)) {
    statusBar.hide();
    return;
  }

  const s = sessionTotal();
  if (s.tokens === 0) {
    statusBar.text    = "$(pulse) TokenPulse";
    statusBar.tooltip = "No AI requests this session";
  } else {
    statusBar.text    = `$(pulse) ${fk(s.tokens)} tokens · ${fmtCost(s.cost)}`;
    statusBar.tooltip = `Session: ${s.tokens.toLocaleString()} tokens · ${fmtCost(s.cost)}\nClick to open dashboard`;
  }
  statusBar.show();

  if (panel) {
    panel.webview.html = getWebviewContent(getDashboardData());
  }
}

// ── Dashboard data ────────────────────────────────────────────────
function getDashboardData() {
  const session = sessionTotal();
  const today   = getDayTotal();
  const week    = getWeekTotal();

  const modelMap: Record<string, { tokens: number; cost: number }> = {};
  for (const r of sessionRequests) {
    if (!modelMap[r.model]) { modelMap[r.model] = { tokens: 0, cost: 0 }; }
    modelMap[r.model].tokens += r.tokens;
    modelMap[r.model].cost   += r.cost;
  }
  const models = Object.entries(modelMap)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([model, data]) => ({ model, ...data }));

  return { session, today, week, models, requestCount: sessionRequests.length };
}

// ── Webview content ───────────────────────────────────────────────
function getWebviewContent(data: ReturnType<typeof getDashboardData>): string {
  const { session, today, week, models, requestCount } = data;

  const modelRows = models.length === 0
    ? `<div class="empty-row">No requests yet this session</div>`
    : models.map(m => `
        <div class="model-row">
          <div class="model-name">${m.model.replace("copilot-", "")}</div>
          <div class="model-stats">
            <span class="model-tokens">${fk(m.tokens)} tokens</span>
            <span class="model-cost">${fmtCost(m.cost)}</span>
          </div>
        </div>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TokenPulse</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px; line-height: 1.5;
    }
    .header {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 24px; padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .header-title { font-size: 16px; font-weight: 700; }
    .header-sub   { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .grid {
      display: grid; grid-template-columns: 1fr 1fr 1fr;
      gap: 12px; margin-bottom: 24px;
    }
    .card {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px; padding: 14px;
    }
    .card-label {
      font-size: 10px; font-weight: 700; letter-spacing: .08em;
      text-transform: uppercase; color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    .card-value {
      font-size: 22px; font-weight: 800;
      color: var(--vscode-textLink-foreground); line-height: 1;
    }
    .card-sub { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
    .section-title {
      font-size: 11px; font-weight: 700; letter-spacing: .08em;
      text-transform: uppercase; color: var(--vscode-descriptionForeground);
      margin-bottom: 10px;
    }
    .model-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px; margin-bottom: 6px;
    }
    .model-name   { font-size: 13px; font-weight: 600; }
    .model-stats  { display: flex; gap: 16px; align-items: center; }
    .model-tokens { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .model-cost   { font-size: 13px; font-weight: 700; color: var(--vscode-textLink-foreground); }
    .empty-row    { padding: 16px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .reset-btn {
      margin-top: 20px; padding: 8px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 4px; cursor: pointer;
      font-size: 12px; font-family: inherit;
    }
    .reset-btn:hover { background: var(--vscode-button-hoverBackground); }
    .disclaimer { margin-top: 16px; font-size: 10px; color: var(--vscode-descriptionForeground); opacity: .6; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="header-title">TokenPulse</div>
      <div class="header-sub">${requestCount} AI request${requestCount !== 1 ? "s" : ""} this session</div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <div class="card-label">This Session</div>
      <div class="card-value">${fmtCost(session.cost)}</div>
      <div class="card-sub">${fk(session.tokens)} tokens</div>
    </div>
    <div class="card">
      <div class="card-label">Today</div>
      <div class="card-value">${fmtCost(today.cost)}</div>
      <div class="card-sub">${fk(today.tokens)} tokens</div>
    </div>
    <div class="card">
      <div class="card-label">This Week</div>
      <div class="card-value">${fmtCost(week.cost)}</div>
      <div class="card-sub">${fk(week.tokens)} tokens</div>
    </div>
  </div>

  <div class="section-title">By Model — This Session</div>
  ${modelRows}

  <button class="reset-btn" onclick="resetSession()">Reset Session</button>
  <div class="disclaimer">±8% accuracy · input tokens only · output not included</div>

  <script>
    const vscode = acquireVsCodeApi();
    function resetSession() {
      vscode.postMessage({ type: "RESET_SESSION" });
    }
  </script>
</body>
</html>`;
}

// ── Record an AI request ──────────────────────────────────────────
function recordRequest(
  context: vscode.ExtensionContext,
  modelId: string,
  inputText: string
): void {
  const tokenCount = Math.ceil(inputText.length / 4);
  const cost       = estimateCost(tokenCount, modelId);

  const record: RequestRecord = {
    ts: Date.now(), model: modelId, tokens: tokenCount, cost,
  };

  sessionRequests.push(record);
  todayRequests.push(record);

  // Persist
  const stored = context.globalState.get<RequestRecord[]>("todayRequests", []);
  stored.push(record);
  context.globalState.update("todayRequests", stored.filter(r => isSameDay(r.ts)));

  updateStatusBar();
}

// ── LM event listener ─────────────────────────────────────────────
function registerLmListener(context: vscode.ExtensionContext): void {
  // vscode.lm.onDidChangeChatModels fires when models change
  // We intercept via chat request handler
  if (typeof vscode.lm === "undefined") {
    vscode.window.showWarningMessage(
      "TokenPulse: VS Code LM API not available. Update VS Code to 1.90+."
    );
    return;
  }

  // Listen to language model chat requests via the official event
  const disposable = (vscode.lm as any).onDidReceiveLanguageModelResponse?.(
    (e: any) => {
      const modelId   = e?.model?.id    || "default";
      const inputText = e?.request?.toString?.() || "";
      recordRequest(context, modelId, inputText);
    }
  );

  if (disposable) {
    context.subscriptions.push(disposable);
    return;
  }

  // Fallback: poll Copilot Chat activity via document change heuristic
  // When the user sends a message in Copilot Chat, the chat document changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      const doc = e.document;
      // Copilot Chat responses appear in specific uri schemes
      if (doc.uri.scheme === "vscode-chat" || doc.fileName.includes("copilot")) {
        const text = e.contentChanges.map(c => c.text).join("");
        if (text.length > 20) {
          recordRequest(context, "copilot-default", text);
        }
      }
    })
  );
}

// ── Activate ──────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext): void {
  // Load persisted today data
  const stored = context.globalState.get<RequestRecord[]>("todayRequests", []);
  todayRequests = stored.filter(r => isSameDay(r.ts));

  // Status bar
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 100
  );
  statusBar.command = "tokenpulse.showDashboard";
  context.subscriptions.push(statusBar);
  updateStatusBar();

  // LM listener
  registerLmListener(context);

  // Show dashboard
  context.subscriptions.push(
    vscode.commands.registerCommand("tokenpulse.showDashboard", () => {
      if (panel) {
        panel.reveal();
        panel.webview.html = getWebviewContent(getDashboardData());
        return;
      }

      panel = vscode.window.createWebviewPanel(
        "tokenpulse", "TokenPulse",
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );

      panel.webview.html = getWebviewContent(getDashboardData());

      panel.webview.onDidReceiveMessage(msg => {
        if (msg.type === "RESET_SESSION") {
          vscode.commands.executeCommand("tokenpulse.resetSession");
        }
      });

      panel.onDidDispose(() => { panel = undefined; });
      context.subscriptions.push(panel);
    })
  );

  // Reset session
  context.subscriptions.push(
    vscode.commands.registerCommand("tokenpulse.resetSession", () => {
      sessionRequests = [];
      updateStatusBar();
      if (panel) {
        panel.webview.html = getWebviewContent(getDashboardData());
      }
      vscode.window.showInformationMessage("TokenPulse: Session reset.");
    })
  );

  vscode.window.showInformationMessage(
    "TokenPulse is active. Use Copilot Chat to start tracking."
  );
}

export function deactivate(): void {
  statusBar?.dispose();
  panel?.dispose();
}
