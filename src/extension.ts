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

