import * as vscode from "vscode";

// -- Pricing per 1M input tokens (USD) -----
const COST_PER_M: Record<string, number> = {
	"copilot-gpt-4o":			2.50,
	"copilot-gpt-4o-mini":		0.15,
	"copilot-claude-sonnet-4":	3.00,
	"copilot-calude-opus-4":    15.00,
	"copilot-o1":				15.00,
	"copilot-o3-mini":			 1.10,
	"default":					 2.50,
};

// -- Session state ----
interface RequestRecord {
	ts:			number;
	model:		string;
	tokens:		number;
	cost:		number;
}

let sessionRequests: RequestRecord[] = [];
let todayRequests: RequestRecord[] = [];
let statusBar:	   vscode.StatusBarItem;
let panel:		   vscode.WebviewPanel | undefined;

// -- Helpers --
function estimateCost(tokens: number, model: string): number {
	const price = COST_PER_M[model] ?? COST_PER_M["default"];
	return (tokens / 1_00_000) * price;
}

function fmtCost(usd: number): string {
	if (usd <= 0)		return "$0.00";
	if (usd < 0.001)	return "<$0.001";
	if (usd < 0.01)		return "$" + usd.toFixed(4);
	if (usd < 1)		return "$" + usd.toFixed(3);
	return "$" + usd.toFixed(2);
}

function fk(n: number): string {
	if (n >= 1000) return (n / 1000).toFixed(1) + "k";
	return String(Math.round(n));
}

function isSameDay(ts: number): boolean {
	const d = new Date(ts);
	const now = new Date();
	return d.getDate() === now.getDate() &&
		   d.getMonth() === now.getMonth() &&
		   d.getFullYear() === now.getFullYear();
}

function todayToday(): { tokens: number; cost: number } {
	const recs = todayRequests.filter(r => isSameDay(r.ts));
	return {
		tokens: recs.reduce((s, r) => s + r.tokens, 0),
		cost: recs.reduce((s, r) => s + r.cost, 0), 
	};
}

function sessionTotal(): { tokens: number; cost: number } {
	return {
		tokens: sessionRequests.reduce((s, r) => s + r.tokens, 0),
		cost: sessionRequests.reduce((s, r) => s + r.cost, 0),
	};
}

function weekTotal(): { tokens: number; cost: number } {
	const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
	const recs = todayRequests.filter(r => r.ts >= weekAgo);
	return {
		tokens: recs.reduce((s, r) => s + r.tokens, 0),
		cost: recs.reduce((s, r) => s + r.cost, 0),
	};
}

// -- Status bar update --
function updateStatusBar(): void {
	const config = vscode.workspace.getConfiguration("tokenpulse");
	if (!config.get<boolean>("showStatusBar", true)) {
		statusBar.hide();
		return;
	}

	const s = sessionTotal();
	if (s.tokens === 0) {
		statusBar.text = "$(pulse) TokenPulse";
		statusBar.tooltip = "No AI requests this session";
	} else {
		statusBar.text = `$(pulse) ${fk(s.tokens)} tokens . ${fmtCost(s.cost)}`;
		statusBar.tooltip = `Session: ${s.tokens.toLocaleString()} tokens . ${fmtCost(s.cost)}\nClick to open dashboard`;
	}
	statusBar.show();

	// Update panel if open
	if (panel) {
		panel.webview.postMessage({ type: "UPDATE", data: getDashboardData() });
	}
}

// -- Dashboard data --
function getDashboardData() {
	const session = sessionTotal();
	const today   = todayTotal();
	const week    = weekTotal();
	
	// Model breakdown for session
	const modelMap: Record<string, { tokens: number; cost: number }> = {};
	for (const r of sessionRequests) {
		if (!modelMap[r.model]) { modelMap[r.model] = { tokens: 0, cost: 0 }; }
		modelMap[r.model].tokens += r.tokens;
		modelMap[r.model].cost += r.cost;
	}
	const models = Object.entries(modelMap)
	  .sort((a, b) => b[1].tokens - a[1].tokens)
	  .map(([model, data]) => ({ model, ...data }));

	return {
		session,
		today,
		week,
		models,
		requestCount: sessionRequests.length,
	};
}

// -- Webview panel ---
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
			padding: 20px;
			line-height: 1.5;   
		  }
			
		 .header {
		   display: flex; align-items: center; gap: 10px;
		   margin-bottom: 24px; padding-bottom: 16px;
		   border-bottom: 1px solid var(--vscode-panel-border);
		 }
		 .header-title { font-size: 16px; font-weight: 700; }
		 .header-sub { font-size: 11px; color: var(--vscode-descriptionForeground); }
		 
		 .grid { display: grid; grid-template-colums: 1fr 1fr 1fr; gap: 12px; margin-bottom: 24px; }
		 
		 .card {
		 	background: var(--vscode-input-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 8px; padding: 14px;
		 }
		 .card-label {
		   font-size: 10px; font-weight: 700; letter-spacing; .08em;
		   text-transform: uppercase; color: var(--vscode-descriptionForeground);
		   margin-bottom: 8px;
		 }
		 .card-value {
		   font-size: 22px; font-weight: 800; color: var(--vscode-textLink-foreground);
		   line-height: 1;
		 }
		 .card-sub { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
		 
		 .section-title {
		   font-size: 11px; font-weight: 700; letter-spacing: .08em;
		   text-transform: uppercase; color: var(--vscode-descriptionForeground);
		   margin-buttom: 10px;  
		   }
		   
		   .model-row {
		 	  display: flex; align-item: center; justify-content: space-between;
			  padding: 10px 14px;
			  background: var(--vscode-input-background);
			  border: 1px solid var(--vscode-panel-border);
			  border-radius: 6px; margin-bottom: 6px;
		   }
			.model-name { font-size: 13px; font-weight: 600; }
			.model-stats { display: flex; gap: 16px; align-items: center; }
			    `
}