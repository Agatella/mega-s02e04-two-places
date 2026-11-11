#!/usr/bin/env node
/**
 * Minimal MCP-over-Streamable-HTTP client for S02E04 "two places".
 * One script runs either job; the orchestrator (this repo's README)
 * picks which job goes where.
 *
 * Usage:
 *   node src/run-job.mjs --job 1 --url <job-1 MCP URL>
 *   node src/run-job.mjs --job 2 --url <job-2 MCP URL> --clip <clip URL>
 *
 * Writes progress to stderr and a single JSON summary to stdout.
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		url: { type: "string" },
		job: { type: "string" },
		clip: { type: "string" },
	},
});

if (!values.url || (values.job !== "1" && values.job !== "2")) {
	console.error("usage: run-job.mjs --job 1|2 --url <mcp-url> [--clip <audio-url>]");
	process.exit(2);
}
if (values.job === "2" && !values.clip) {
	console.error("job 2 needs --clip <audio-url>");
	process.exit(2);
}

const PROTO = "2026-07-28";
const CLIENT = { name: "two-places-worker", version: "0.1.0" };

async function rpc(url, method, params = {}, extraHeaders = {}) {
	const body = {
		jsonrpc: "2.0",
		id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		method,
		params: {
			...params,
			_meta: {
				"io.modelcontextprotocol/protocolVersion": PROTO,
				"io.modelcontextprotocol/clientInfo": CLIENT,
				"io.modelcontextprotocol/clientCapabilities": {},
			},
		},
	};
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"Mcp-Method": method,
			...extraHeaders,
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		const lines = text
			.split(/\r?\n/)
			.filter((l) => l.startsWith("data: "))
			.map((l) => l.slice(6));
		const last = lines[lines.length - 1];
		if (!last) throw new Error(`unexpected response (${res.status}): ${text.slice(0, 300)}`);
		payload = JSON.parse(last);
	}
	if (payload.error) {
		throw new Error(
			`rpc ${method} failed: ${payload.error.code} ${payload.error.message} ${
				payload.error.data ? JSON.stringify(payload.error.data) : ""
			}`,
		);
	}
	return payload.result;
}

async function callTool(url, name, args) {
	const result = await rpc(url, "tools/call", { name, arguments: args }, {
		"Mcp-Name": name,
	});
	if (result?.isError) {
		const text = result.content?.find?.((c) => c.type === "text")?.text;
		throw new Error(`tool ${name} returned isError: ${text ?? JSON.stringify(result)}`);
	}
	return result;
}

/** Pull the structured payload out of a MCP tool result. */
function payload(result) {
	if (result?.structuredContent !== undefined) return result.structuredContent;
	const text = result?.content?.find?.((c) => c.type === "text")?.text;
	if (text === undefined) return result;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** Pull the step token out of a payload, trying common field names. */
function step(p) {
	if (p == null || typeof p !== "object") return undefined;
	return (
		p.step ??
		p.stepToken ??
		p.step_token ??
		p.nextStep ??
		p.next_step ??
		p.token
	);
}

function requireStep(p, after) {
	const s = step(p);
	if (!s) throw new Error(`no step token after ${after}: ${JSON.stringify(p).slice(0, 400)}`);
	return s;
}

function err(...args) {
	console.error("[worker]", ...args);
}

async function runJob1(url) {
	err("job 1: search scope ops/live");
	const searchP = payload(
		await callTool(url, "search", { query: "tram-3", scope: "ops/live" }),
	);
	err("search payload:", JSON.stringify(searchP).slice(0, 600));
	const results = searchP.results ?? searchP.entries ?? searchP.hits ?? [];
	// pick entry about tram-3; prefer one whose own fields name tram-3
	const entry =
		results.find((r) =>
			/tram-?3/i.test(JSON.stringify({ ...r, step: undefined })),
		) ?? results[0];
	if (!entry) throw new Error("no tram-3 entry in search result");
	let token = requireStep(searchP, "search");

	err("job 1: read entry", entry.id);
	const readP = payload(
		await callTool(url, "read", {
			id: entry.id,
			fields: ["date", "time", "clock", "line", "cause"],
			step: token,
		}),
	);
	err("read payload:", JSON.stringify(readP).slice(0, 600));
	token = requireStep(readP, "read");

	// Pick the record object out of the payload.
	const record =
		readP.entry ??
		readP.record ??
		readP.fields ??
		(() => {
			const { step: _s, stepToken: _t, ...rest } = readP;
			return rest;
		})();

	const order = ["date", "time", "clock", "line", "cause"];
	const lines = order
		.filter((f) => record[f] !== undefined && record[f] !== null && record[f] !== "")
		.map((f) => `${f}: ${record[f]}`);
	const rawText = lines.join("\n");
	err("raw text to redact:\n" + rawText);

	err("job 1: redact");
	const redactP = payload(
		await callTool(url, "redact", { text: rawText, step: token }),
	);
	err("redact payload:", JSON.stringify(redactP).slice(0, 600));
	token = requireStep(redactP, "redact");
	const redactedText =
		typeof redactP === "string"
			? redactP
			: redactP.text ?? redactP.redacted ?? redactP.result;
	if (typeof redactedText !== "string") {
		throw new Error(`no redacted text: ${JSON.stringify(redactP)}`);
	}

	err("job 1: submit");
	const submitP = payload(
		await callTool(url, "submit", {
			result: redactedText,
			skillVersion: "1",
			step: token,
		}),
	);
	err("submit payload:", JSON.stringify(submitP).slice(0, 600));

	process.stdout.write(
		JSON.stringify(
			{
				job: "job-1",
				redacted: redactedText,
				receipt: submitP.receipt ?? submitP.receiptId ?? submitP.id,
				result: submitP.result ?? submitP,
				raw: submitP,
			},
			null,
			2,
		),
	);
}

async function runJob2(url, clipUrl) {
	err("job 2: transcribe");
	const transP = payload(
		await callTool(url, "transcribe", { url: clipUrl }),
	);
	err("transcribe payload (full):", JSON.stringify(transP));
	let token = requireStep(transP, "transcribe");
	const segments = transP.segments ?? transP.result?.segments ?? [];
	if (!Array.isArray(segments) || segments.length === 0) {
		throw new Error(`no segments in transcribe result: ${JSON.stringify(transP)}`);
	}

	// A finding is anything that happened on a line: fault, freeze/stall,
	// hold, reset. Catch every word form; miss nothing.
	const EVENT_RX =
		/\b(fault\w*|freez\w*|froze\w*|stall\w*|hold\w*|held|reset\w*|restart\w*|reboot\w*|drop(?:ped|ping)?|outage\w*|power\s+loss|failur\w*|degrad\w*|refresh.*stall)\b/i;
	const notesToWrite = segments
		.filter((s) => EVENT_RX.test(s.text ?? ""))
		.map((s) => ({
			text: (s.text ?? "").trim(),
			at: mmssOf(s),
		}));

	err(`segments: ${segments.length}, findings: ${notesToWrite.length}`);
	if (notesToWrite.length === 0) {
		err("no finding matched; falling back to one memo per segment");
		for (const s of segments) {
			notesToWrite.push({
				text: (s.text ?? "").trim(),
				at: mmssOf(s),
			});
		}
	}

	const written = [];
	for (const n of notesToWrite) {
		const noteLine = `${n.text} @${n.at}`;
		err("job 2: memo_write", noteLine);
		const memoP = payload(
			await callTool(url, "memo_write", { text: noteLine, step: token }),
		);
		token = requireStep(memoP, "memo_write");
		written.push(noteLine);
	}

	err("job 2: memo_search no query");
	const searchP = payload(
		await callTool(url, "memo_search", { query: "", step: token }),
	);
	err("memo_search payload:", JSON.stringify(searchP));
	token = requireStep(searchP, "memo_search");
	const notes = searchP.notes ?? searchP.results ?? [];

	const submissionLines = written; // submit exactly what we wrote, one per line
	const submitText = submissionLines.join("\n");
	err("job 2: submit (text):\n" + submitText);
	const submitP = payload(
		await callTool(url, "submit", {
			result: submitText,
			skillVersion: "1",
			step: token,
		}),
	);
	err("submit payload:", JSON.stringify(submitP));

	process.stdout.write(
		JSON.stringify(
			{
				job: "job-2",
				segments: segments.length,
				segmentsFull: segments,
				written,
				notes,
				submission: submitText,
				receipt: submitP.receipt ?? submitP.receiptId ?? submitP.id,
				result: submitP.result ?? submitP,
				raw: submitP,
			},
			null,
			2,
		),
	);
}

/** Produce "m:ss" from a segment's `at` (pre-formatted) or `start` (seconds). */
function mmssOf(s) {
	if (typeof s?.at === "string" && /^\d{1,2}:\d{2}$/.test(s.at)) return s.at;
	const start = Number(s?.start);
	if (!Number.isFinite(start) || start < 0) return "0:00";
	const m = Math.floor(start / 60);
	const sec = Math.floor(start % 60).toString().padStart(2, "0");
	return `${m}:${sec}`;
}

try {
	if (values.job === "1") await runJob1(values.url);
	else await runJob2(values.url, values.clip);
} catch (e) {
	console.error("[worker] failed:", e.message);
	process.exit(1);
}
