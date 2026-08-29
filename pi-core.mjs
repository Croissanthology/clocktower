// clocktower agent core, ported onto @earendil-works/pi-agent-core.
//
// Each AI player turn runs through a Pi `Agent`: one user message in, one
// assistant message out, no tools (the clocktower contract is single-shot
// strict-JSON — the player's only memory is its sheet, not the transcript).
//
// The subscription model is preserved: instead of a network provider we install
// a custom `StreamFn` that wraps the two backends clocktower already uses —
// headless `claude -p` (rides the Claude subscription, no API tokens) and
// OpenRouter over HTTPS. Pi's StreamFn contract is "never throw; encode every
// failure as an error event carrying an AssistantMessage with stopReason
// 'error'/'aborted'". That is the robustness win: a CLI crash, a timeout, a
// malformed OpenRouter body, or an abort all arrive as one clean, typed result
// on exactly one code path, and the Agent surfaces them via state.errorMessage
// instead of leaking as an unhandled rejection or a half-written callback.
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import https from "node:https";

const EMPTY_USAGE = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// A minimal but valid Model<Api>. Our own StreamFn is the only thing that reads
// it, so the fields just have to be well-formed — no real provider is contacted.
function fakeModel(backend, modelId) {
	return {
		id: modelId,
		name: modelId,
		api: "anthropic-messages",
		provider: backend, // "claude-cli" | "openrouter" — dispatched on in the StreamFn
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function baseAssistant(model) {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...EMPTY_USAGE },
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

// Pull the user text back out of the Pi context. `agent.prompt(string)` stores it
// as a UserMessage whose content is that string.
function lastUserText(context) {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const m = context.messages[i];
		if (m.role !== "user") continue;
		return typeof m.content === "string"
			? m.content
			: (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
	}
	return "";
}

// claude CLI stream-json → {text, thinking}. Falls back to treating the blob as
// plain text (mirrors the original server.js parser).
function parseStreamJson(stdout) {
	let text = "", thinking = "", parsedAny = false;
	for (const line of stdout.split("\n")) {
		const l = line.trim();
		if (!l.startsWith("{")) continue;
		try {
			const j = JSON.parse(l);
			parsedAny = true;
			if (j.type === "assistant" && j.message && Array.isArray(j.message.content)) {
				for (const b of j.message.content) {
					if (b.type === "thinking" && b.thinking) thinking += b.thinking + "\n";
					if (b.type === "text" && b.text) text += b.text;
				}
			}
			if (j.type === "result" && typeof j.result === "string") text = j.result;
		} catch (e) {}
	}
	if (!parsedAny) return { text: stdout, thinking: "" };
	return { text: text.trim(), thinking: thinking.trim() };
}

// Backend 1: headless claude on the subscription. Resolves {text, thinking} or
// rejects; the StreamFn wrapper turns a rejection into a stream error event.
function runClaudeCli({ model, sysFile, userMsg, effort, cwd, timeoutMs, signal }) {
	return new Promise((resolve, reject) => {
		const args = [
			"-p", "--model", model, "--effort", effort,
			"--system-prompt-file", sysFile, "--no-session-persistence", "--disallowedTools", "*",
			"--output-format", "stream-json", "--verbose",
		];
		const child = execFile(
			"claude", args,
			{ cwd, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 },
			(err, stdout, stderr) => {
				const { text, thinking } = parseStreamJson((stdout || "").trim());
				// Match the original contract: an error is only fatal if nothing came
				// back. A non-zero exit that still produced parseable text is usable.
				if (err && !text) {
					const e = new Error(`claude cli: ${String(err).slice(0, 300)}`);
					e.stderr = (stderr || "").slice(0, 2000);
					return reject(e);
				}
				resolve({ text, thinking, stderr: (stderr || "").slice(0, 2000) });
			},
		);
		if (signal) {
			if (signal.aborted) { try { child.kill("SIGTERM"); } catch (e) {} }
			else signal.addEventListener("abort", () => { try { child.kill("SIGTERM"); } catch (e) {} }, { once: true });
		}
		try { child.stdin.write(userMsg); child.stdin.end(); } catch (e) { reject(e); }
	});
}

// Backend 2: OpenRouter over HTTPS (any model id containing "/").
function runOpenrouter({ model, sysText, userMsg, effort, maxTokens, key, timeoutMs, signal }) {
	return new Promise((resolve, reject) => {
		if (!key) return reject(new Error("no openrouter key — paste it into clocktower/openrouter.key (one line) or set OPENROUTER_API_KEY"));
		const bodyStr = JSON.stringify({
			model, max_tokens: maxTokens, reasoning: { effort },
			messages: [{ role: "system", content: sysText }, { role: "user", content: userMsg }],
		});
		const req = https.request({
			hostname: "openrouter.ai", path: "/api/v1/chat/completions", method: "POST",
			headers: {
				"Authorization": "Bearer " + key,
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(bodyStr),
			},
			timeout: timeoutMs,
		}, (res) => {
			let d = "";
			res.on("data", (c) => (d += c));
			res.on("end", () => {
				try {
					const j = JSON.parse(d);
					if (j.error) return reject(new Error("openrouter: " + String(j.error.message || JSON.stringify(j.error)).slice(0, 200)));
					const m = (j.choices || [])[0]?.message || {};
					resolve({
						text: (m.content || "").trim(),
						thinking: (m.reasoning || m.reasoning_content || "").trim(),
						stderr: "",
					});
				} catch (e) {
					reject(new Error("openrouter bad response: " + d.slice(0, 200)));
				}
			});
		});
		req.on("timeout", () => req.destroy(new Error("openrouter timeout")));
		req.on("error", reject);
		if (signal) {
			if (signal.aborted) req.destroy(new Error("aborted"));
			else signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
		}
		req.write(bodyStr);
		req.end();
	});
}

// Build the per-turn StreamFn. It closes over the backend + params for this one
// player turn, so the Model/options plumbing stays trivial. It NEVER throws:
// every outcome is pushed onto the returned stream as `done` or `error`.
function makeStreamFn(cfg) {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const signal = options?.signal;
		const partial = baseAssistant(model);
		stream.push({ type: "start", partial });

		const backend = cfg.backend === "openrouter"
			? runOpenrouter({
					model: cfg.model, sysText: cfg.sysText ?? readFileSync(cfg.sysFile, "utf8"),
					userMsg: lastUserText(context), effort: cfg.effort, maxTokens: cfg.maxTokens,
					key: cfg.openrouterKey, timeoutMs: cfg.timeoutMs, signal,
			  })
			: runClaudeCli({
					model: cfg.model, sysFile: cfg.sysFile, userMsg: lastUserText(context),
					effort: cfg.effort, cwd: cfg.cwd, timeoutMs: cfg.timeoutMs, signal,
			  });

		backend.then(
			({ text, thinking, stderr }) => {
				const content = [];
				if (thinking) content.push({ type: "thinking", thinking });
				content.push({ type: "text", text: text || "" });
				const message = {
					...partial, content,
					stopReason: "stop", stderr, timestamp: Date.now(),
				};
				stream.push({ type: "text_start", contentIndex: 0, partial: message });
				stream.push({ type: "text_delta", contentIndex: 0, delta: text || "", partial: message });
				stream.push({ type: "text_end", contentIndex: 0, content: text || "", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			},
			(err) => {
				const aborted = signal?.aborted || /abort/i.test(String(err && err.message));
				const error = {
					...partial, content: [],
					stopReason: aborted ? "aborted" : "error",
					errorMessage: String((err && err.message) || err).slice(0, 500),
					stderr: (err && err.stderr) || "",
					timestamp: Date.now(),
				};
				stream.push({ type: "error", reason: aborted ? "aborted" : "error", error });
			},
		);

		return stream;
	};
}

/**
 * Run one clocktower player turn through a Pi Agent.
 *
 * @param {object} o
 * @param {string} o.name       player name (for labelling only)
 * @param {"claude-cli"|"openrouter"} o.backend
 * @param {string} o.model      concrete model id passed to the backend
 * @param {string} o.sysFile    path to the player's system-prompt file
 * @param {string} o.userMsg    the built user message for this tick
 * @param {string} o.effort     thinking level ("off"|"low"|"medium"|"high"|...)
 * @param {number} o.maxTokens  output cap (openrouter)
 * @param {string} o.cwd        working dir for the claude CLI
 * @param {number} o.timeoutMs  hard per-call timeout
 * @param {string} [o.openrouterKey]
 * @param {AbortSignal} [o.signal]  optional external abort (e.g. phase change)
 * @returns {Promise<{text:string, thinking:string, stderr:string, error:string|null, aborted:boolean}>}
 *          Always resolves — failures come back as `error` (never a rejection).
 */
export async function runPlayerTurn(o) {
	const model = fakeModel(o.backend, o.model);
	const thinkingLevel = o.effort === "off" ? "off" : (o.effort || "medium");
	const agent = new Agent({
		initialState: {
			systemPrompt: (() => { try { return readFileSync(o.sysFile, "utf8"); } catch (e) { return ""; } })(),
			model,
			thinkingLevel,
		},
		streamFn: makeStreamFn({
			backend: o.backend, model: o.model, sysFile: o.sysFile,
			effort: o.effort, maxTokens: o.maxTokens ?? 8000, cwd: o.cwd,
			timeoutMs: o.timeoutMs ?? 120000, openrouterKey: o.openrouterKey || "",
		}),
	});

	// External abort (optional): wire it to the Agent's own abort path.
	if (o.signal) {
		if (o.signal.aborted) agent.abort();
		else o.signal.addEventListener("abort", () => agent.abort(), { once: true });
	}

	try {
		await agent.prompt(o.userMsg);
		await agent.waitForIdle();
	} catch (e) {
		// The loop is contracted not to throw, but guard anyway so callers always
		// get a value, never a rejection.
		return { text: "", thinking: "", stderr: "", error: String((e && e.message) || e).slice(0, 500), aborted: false };
	}

	const msgs = agent.state.messages;
	let final = null;
	for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "assistant") { final = msgs[i]; break; }

	if (!final) {
		return { text: "", thinking: "", stderr: "", error: agent.state.errorMessage || "no assistant message produced", aborted: false };
	}
	const text = (final.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
	const thinking = (final.content || []).filter((c) => c.type === "thinking").map((c) => c.thinking).join("\n").trim();
	const aborted = final.stopReason === "aborted";
	const errored = final.stopReason === "error" || final.stopReason === "aborted";
	return {
		text,
		thinking,
		stderr: final.stderr || "",
		error: errored ? (final.errorMessage || "stream error") : null,
		aborted,
	};
}
