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
