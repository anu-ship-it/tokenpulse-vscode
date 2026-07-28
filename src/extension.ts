import * as vscode from "vscode";
import * as fs from "fs";

const BACKEND_URL = "https://tokenpulsevscode-backend.onrender.com";
const AUTH_KEY    = "tokenpulse.authToken";

// ── Pricing per 1M input tokens ────────────────────────────
const COST_PER_M: Record<string, number> = {
  "copilot-gpt-4o":           2.50,
  "copilot-gpt-4o-mini":      0.15,
  "copilot-claude-sonnet-4":  3.00,
  "copilot-claude-opus-4":    15.00,
  "copilot-o1":               15.00,
  "copilot-o3-mini":          1.10,
  "default":                  2.50,
};


// ── Types ────────────────────────────
interface RequestRecord {
  ts:         number;
  model:      string;
  tokens:     number;
  cost:       number;
}

// ── State ────────────────────────────
let sessionRequests:  RequestRecord[] = [];
let allRequests:      RequestRecord[] = [];
let statusBar:        RequestRecord[] = [];
let panel:            vscode.WebviewPanel | undefined;
let monthlyBudget    = 20;

// ── Helpers ────────────────────────────
function estimateCost(tokens: number, model: string): number {
  const price = COST_PER_M[model] ?? COST_PER_M["default"];
  return (tokens / 1_000_000) * price;
}

function fmtCost(usd: number): string {
  if (usd <= 0)     return "$0.00";
  if (usd < 0.001)  return "<$0.001";
  if (usd < 0.01)   return "$" + usd.toFixed(4);
  if (usd < 1)      return "$" + usd.toFixed(3);
  return "$" + usd.toFixed(2);
}

function fk(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000)      return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}

function isSameDay(ts: number): boolean {
  const d = new Date(ts), now = new Date();
  return d.getDate() === now.getDate() &&
         d.getMonth() === now.getMonth() &&
         d.getFullYear() === now.getFullYear();
}

function isWithinDays(ts: number, days: number): boolean {
  return ts >= Date.now() - days * 24 * 60 * 60 * 1000;
}

function isSameMonth(ts: number): boolean {
  const d = new Date(ts), now = new Date();
  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

// ── Aggregations ────────────────────────────
function sessionTotal() {
  return {
    tokens: sessionRequests.reduce((s, r) => s + r.tokens, 0),
    cost: sessionRequests.reduce((s, r) => s + r.cost, 0),
  };
}

function dayTotal() {
  const recs = allRequests.filter(r => isSameDay(r.ts));
  return {
    tokens: recs.reduce((s, r) => s + r.tokens, 0),
    cost: recs.reduce((s, r) => s + r.cost, 0),
  };
}

function weekTotal() {
  const recs = allRequests.filter(r => isWithinDays(r.ts, 7));
  return {
    tokens: recs.reduce((s, r) => s + r.tokens, 0),
    cost: recs.reduce((s, r) => s + r.cost, 0),
  };
}

function monthTotal() {
  const recs = allRequests.filter(r => isSameMonth(r.ts));
  return {
    tokens: recs.reduce((s, r) => s + r.tokens, 0),
    cost:   recs.reduce((s, r) => s + r.cost, 0),
  };
}

function modelBreakdown() {
  const map: Record<string, { tokens: number; cost: number }> = {};
  for (const r of sessionRequests) {
    if (!map[r.model]) { map[r.model] = { tokens: 0, cost: 0 }; }
    map[r.model].tokens += r.tokens;
    map[r.model].cost   += r.cost;
  }
  return Object.entries(map)
    .map(([modelBreakdown, d]) => ({ model, ...d }))
    .sort((a, b) => b.cost - a.cost);
}

function heatmapData() {
  const map: Record<string, number> = {};
  const recs = allRequests.filter(r => isWithinDays(r.ts, 7));
  for (const r of recs) {
    const d = new Date(r.ts);
    const key = `${d.toISOString().split("T")[0]}-${d.getHours()}`;
    map[key]  = (map[key] || 0) + r.cost;
  }
  return map;
}

// ── Active file token count ────────────────────────────
function getActiveFileTokens(): { tokens: number; selected: number } {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return { tokens: 0, selected: 0}; }
  return {
    tokens: Math.ceil(editor.document.getText().length / 4),
    selected: Math.ceil(editor.document.getText(editor.selection).length / 4),
  };
}

// ── Dashboard data ────────────────────────────
async function getDashboardData(context: vscode.ExtensionContext) {
  const tokes = await context.secrets.get(AUTH_KEY);
  return {
    session:    sessionTotal(),
    today:      dayTotal(),
    week:       weekTotal(),
    month:      monthTotal(),
    models:     modelBreakdown(),
    heatmap:    heatmapData(),
    budget:     monthlyBudget,
    signedIn:   !!token,
    requestCount: sessionRequests.length,
    file:         getActiveFileTokens(),
  };
}

// ── Status bar ────────────────────────────
async function updateStatusBar(context: vscode.ExtensionContext): Promise<void> {
  const s   = sessionTotal();
  const file = getActiveFileTokens();

  if (s.tokens === 0) {
    statusBar.text    = `$(pulse) ${fk(file.tokens)} tokens in file`;
    statusBar.tooltip = `File: -${file.tokens.toLocaleString()} tokens . Selection:
    -${file.selected.toLocaleString()} tokens\nClick to open dashboard`;
  } else {
    statusBar.text    = `$(pulse) ${fk(s.tokens)} . ${fmtCost(s.cost)}`;
    statusBar.tooltip = `Session: ${s.tokens.toLocaleString()} tokens . ${fmtCost(s.cost)}\nClick to open dashboard`;
  }
  statusBar.show();

  if (panel) {
    const data = await getDashboardData(context);
    panel.webview.postMessage({ type: "UPDATE", ...data });
  }
}

// ── Record request ────────────────────────────
async function recordRequest(
  context: vscode.ExtensionContext,
  modelId: string,
  inputText: string
): Promise<void> {
  const tokenCount = Math.ceil(inputText.length / 4);
  if (tokenCount < 10) { return; } // ignore noise

  const cost = estimateCost(tokenCount, modelId);
  const record: RequestRecord = { ts: Date.now(), model: modelId, tokens: tokenCount, cost };

  sessionRequests.push(record);
  allRequests.push(record);

  // Persist last 30 days
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const stored = context.globalState.get<RequestRecord[]>("requests", []);
  stored.push(record);
  context.globalState.update("requests", stored.filter(r => r.ts > cutoff));

  await updateStatusBar(context);

  // Budget warning at 90%
  const month = monthTotal();
  if (monthlyBudget > 0) {
    const pct = (month.cost / monthlyBudget) * 100;
    if (pct >= 90 && (pct - (cost / monthlyBudget * 100)) < 90) {
      vscode.window.showWarningMessage(
        `TokenPulse: ${Math.round(pct)}% of monthly budget used
        (${fmtCost(month.cost)} of ${fmtCost(monthlyBudget)})`
      );
    }
  }
}

// ── LM listener ────────────────────────────
function registerLmListener(context: vscode.ExtensionContext): void {

  // ── Strategy 1: vscode.lm official API ─────────────────────────
  // Wrap sendRequest if available
  if (vscode.lm && typeof (vscode.lm as any).sendRequest === "function") {
    const original = (vscode.lm as any).sendRequest.bind(vscode.lm);
    (vscode.lm as any).sendRequest = async function(...args: any[]) {
      const response = await original(...args);
      const messages = args[1] || [];
      const inputText = Array.isArray(messages)
        ? messages.map((m: any) => typeof m.content === "string" ? m.content : "").join(" ")
        : "";
      const modelId = args[0]?.id || "default";
      recordRequest(context, modelId, inputText);
      return response;  
    };
    context.subscriptions.push({ dispose: () => {
      (vscode.lm as any).sendRequest = original;
    }});
  }

  // ── Strategy 2: Watch All document changes ───────────────────────
  // This catches Copilot inline completions and chat responses
  // by watching for large text insertions in any document
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      const changes = e.contentChanges;
      if (changes.length === 0) { return; }

      // Sum all text inserted in this event
      const insertedText = changes
        .filter(c => c.text.length > 0)
        .map(c => c.text)
        .join("");

        // Only track meaningful insertions (not single keystrokes)
        // Copilot completions and chat responses are typically 50+ chars
        if (insertedText.length >= 50) {
          const scheme = e.document.url.scheme;
          // Capture from any scheme - cailot uses various internal schemes
          // but we filter by insertion size to avoid noise
          recordRequest(context, "copilot-default", insertedText);
        }
    })
  );

  // ── Strategy 3: Watch terminal for API call patterns ───────────────────
  // When Continue/Cline make API calls, they often log to terminal
  // This is a best-effort passive listener
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) { updateStatusBar(context); }
    })
  );
}

// ── Auth ────────────────────────────
async function signin(context: vscode.ExtensionContext): Promise<void> {
  const authUrl = `${BACKEND_URL}/auth/google?redirect=vscode://tokenpulse/callback`;
  vscode.env.openExternal(vscode.Uri.parse(authUrl));

  const handler = vscode.window.registerUriHandler({
    handleUri(uri: vscode.Uri) {
      const token = new URLSearchParams(uri.query).get("token");
      if (token) {
        context.secrets.store(AUTH_KEY, token);
        vscode.window.showInformationMessage("TokenPulse: Signed in - usage syncs across devices.");
        updateStatusBar(context);
      }
      handler.dispose();
    }
  });
  setTimeout(() => handler.dispose(), 120000);
}

// ── Webview HTML ────────────────────────────
function getWebviewHtml(context: vscode.ExtensionContext): string {
  const htmlPath = vscode.Uri.joinPath(context.extensionUri, "media",
    "dashboard.html");
    try {
      return fs.readFileSync(htmlPath.fsPath, "utf-8");
    } catch {
      return `<html><body style="color:white;padding:20px">Dashboard not found at: ${htmlPath.fsPath}</body></html>`;
    }
}

// ── Activate ────────────────────────────
export function activate(context: vscode.ExtensionContext): void {
  // Load persisted data
  const stored = context.globalState.get<RequestRecord[]>("requests", []);
  allRequests  = stored.filter(r => isWithinDays(r.ts, 30));
  monthlyBudget = context.globalState.get<number>("budget", 20);

  // Status bar
  statusBar   =
  vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "tokenpulse.showDashboard";
  context.subscriptions.push(statusBar);

  // File token watchers
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar(context))
  );

  updateStatusBar(context);

  // LM listener
  registerLmListener(context);

  // Show dashboard command
  context.subscriptions.push(
    vscode.commands.registerCommand("tokenpulse.showDashboard", async () => {
      if (panel) { panel.reveal(); return; }

      panel = vscode.window.createWebviewPanel(
        "tokenpulse", "TokenPulse",
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
        }
      );

      panel.webview.html = getWebviewHtml(context);

      // Send initial data
      const data = await getDashboardData(context);
      panel.webview.postMessage({ type: "UPDATE", ...data });

      // Handle message from webview
      panel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
          case "REFRESH":
            panel!.webview.postMessage({ type: "UPDATE", ...await getDashboardData(context) });
            break;
            case "RESET_SESSION":
              sessionRequests = [];
              await updateStatusBar(context);
              panel!.webview.postMessage({ type: "UPDATE", ...await getDashboardData(context) });
              vscode.window,showInformationMessage("TokenPulse: Session reset.");
              break;
            case "SET_BUDGET":
              monthlyBudget = msg.budget;
              context.globalState.update("budget", monthlyBudget);
              panel!.webview.postMessage({ type: "UPDATE", ...await getDashboardData(context) });
              break;
            case "SIGN_IN":
              await signIn(context);
              break;    
        }
      });

      panel.onDidDispose(() => { panel = undefined; });
      context.subscriptions.push(panel);
    })
  );

  // Reset session
  context.subscriptions.push(
    vscode.commands.registerCommand("tokenpulse.resetSession", async () => {
      sessionRequests = [];
      await updateStatusBar(context);
      vscode.window.showInformationMessage("TokenPulse: Session reset.");
    })
  );

  // Sign in/out
  context.subscriptions.push(
    vscode.commands.registerCommand("tokenpulse.signIn", () => signIn(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("tokenpulse.signOut", async () => {
      await context.secrets.delete(AUTH_KEY);
      vscode.window.showInformationMessage("TokenPulse: Signed out.");
      updateStatusBar(context);
    })
  );

  vscode.window.showInformationMessage("TokenPulse is active.");
}

export function deactivate(): void {
  statusBar?.dispose();
  panel?.dispose();
}
