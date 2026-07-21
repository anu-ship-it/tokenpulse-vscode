const BACKEND_URL = "https://tokenpulsevscode-backend.onrender.com";
const AUTH_KEY    = "tokenpulse.authToken";
const USER_KEY    = "tokenpulse.userEmail";

import * as vscode from "vscode";

// ── SignIn function ────────────────────────────
async function signIn(context: vscode.ExtensionContext): Promise<string | null> {
  // Open Google OAuth in browser
  const authUrl = `${BACKEND_URL}/auth/google?redirect=vscode://tokenpulse/callback`;
  vscode.env.openExternal(vscode.Uri.parse(authUrl));

  // Wait for user to complete OAuth and return token
  return new Promise((resolve) => {
    const handler = vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        const token = new URLSearchParams(uri.query).get("token");
        if (token) {
          context.secrets.store(AUTH_KEY, token);
          resolve(token);
        } else {
          resolve(null);
        }
        handler.dispose();
      }
    });

    // Timeout after 2 minutes
    setTimeout(() => { handler.dispose(); resolve(null); }, 120000);
  });
}

// ── GetToken ────────────────────────────
async function getToken(context: vscode.ExtensionContext): Promise<string | null> {
  return (await context.secrets.get(AUTH_KEY)) ?? null;
}

// ── ReportUsage ────────────────────────────
async function reportUsage(
  context: vscode.ExtensionContext,
  record: RequestRecord
): Promise<void> {
  const token = await getToken(context);
  if (!token) {
    return; // not signed in — skip reporting
  }

  try {
    await fetch(`${BACKEND_URL}/usage/record`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        provider:      record.model.includes("gpt") || record.model.includes("o1") || record.model.includes("o3") ? "openai" : "anthropic",
        model:         record.model,
        input_tokens:  record.tokens,
        output_tokens: 0,
        cost_usd:      record.cost,
      }),
    });
  } catch (_) {
    // Silent fail — don't break the user's workflow
  }
}

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
let extensionContext: vscode.ExtensionContext;

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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character] ?? character));
}

function getWebviewHtml(_context: vscode.ExtensionContext): string {
  const data = getDashboardData();
  const rows = data.models.length === 0
    ? "<tr><td colspan=\"3\">No requests recorded yet.</td></tr>"
    : data.models.map(({ model, tokens, cost }) =>
        `<tr><td>${escapeHtml(model)}</td><td>${tokens.toLocaleString()}</td><td>${fmtCost(cost)}</td></tr>`
      ).join("");

  return `<!doctype html>
<html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px}
.cards{display:flex;gap:12px;flex-wrap:wrap}.card{background:var(--vscode-textBlockQuote-background);padding:14px;min-width:140px}
.label{opacity:.75;font-size:.85em}.value{font-size:1.4em;font-weight:600}table{border-collapse:collapse;margin-top:24px;width:100%}
th,td{text-align:left;padding:8px;border-bottom:1px solid var(--vscode-panel-border)}
</style></head><body><h1>TokenPulse</h1>
<div class="cards">
<div class="card"><div class="label">Session</div><div class="value">${data.session.tokens.toLocaleString()} tokens</div><div>${fmtCost(data.session.cost)}</div></div>
<div class="card"><div class="label">Today</div><div class="value">${data.today.tokens.toLocaleString()} tokens</div><div>${fmtCost(data.today.cost)}</div></div>
<div class="card"><div class="label">Last 7 days</div><div class="value">${data.week.tokens.toLocaleString()} tokens</div><div>${fmtCost(data.week.cost)}</div></div>
<div class="card"><div class="label">Requests</div><div class="value">${data.requestCount}</div></div>
</div><h2>Session by model</h2><table><thead><tr><th>Model</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
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
    panel.webview.html = getWebviewHtml(extensionContext);
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
  reportUsage(context, record);
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
  extensionContext = context;
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
        panel.webview.html = getWebviewHtml(context);
        return;
      }

      panel = vscode.window.createWebviewPanel(
        "tokenpulse", "TokenPulse",
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );

      panel.webview.html = getWebviewHtml(context);

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
        panel.webview.html = getWebviewHtml(context);
      }
      vscode.window.showInformationMessage("TokenPulse: Session reset.");
    })
  );

  vscode.window.showInformationMessage(
    "TokenPulse is active. Use Copilot Chat to start tracking."
  );


// Sign in command
context.subscriptions.push(
  vscode.commands.registerCommand("tokenpulse.signIn", async () => {
    const token = await signIn(context);
    if (token) {
      vscode.window.showInformationMessage("TokenPulse: Signed in successfully. Usage will now sync to your account.");
    } else {
      vscode.window.showErrorMessage("TokenPulse: Sign in failed or timed out.");
    }
  })
);

// Sign out command
context.subscriptions.push(
  vscode.commands.registerCommand("tokenpulse.signOut", async () => {
    await context.secrets.delete(AUTH_KEY);
    vscode.window.showInformationMessage("TokenPulse: Signed out.");
  })
);
}

export function deactivate(): void {
  statusBar?.dispose();
  panel?.dispose();
}
