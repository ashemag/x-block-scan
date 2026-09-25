/**
 * Scan the replies and quote tweets on an X post for accounts that are directly aggressive or
 * hateful toward the original poster, and print only their profile URLs.
 *
 * Reply and quote text is sent to the classifier in memory only. It is never printed or written to disk.
 *
 * Usage: npm run scan -- <tweet-url-or-id> [--passes 3]
 */

import "dotenv/config";
import OpenAI from "openai";

const API_BASE = "https://api.x.com/2";
const BATCH_SIZE = 40;
const MAX_RATE_LIMIT_WAIT_SEC = 60;
const MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-4o";

const SYSTEM_PROMPT =
  "You screen replies and quote tweets to a post by the original poster (OP). The post may describe a third " +
  "party (e.g. someone who messaged the OP). Replies insulting or criticizing that third party are on the OP's " +
  "side and must NOT be flagged. Each response includes replying_to_op: false means it answers someone else in " +
  "the thread, so only flag it if it still clearly attacks the OP. " +
  "Be conservative: flag ONLY responses that are directly aggressive or hateful toward the OP: explicit insults " +
  "or name-calling, threats, harassment, sexual or degrading remarks, telling them to leave/die/shut up, or " +
  "attacks on their gender, race, appearance, or other identity. Do NOT flag disagreement (even blunt or pushy), " +
  "sarcasm, snark, passive-aggressiveness, criticism of the post's argument, condescension, 'well actually' " +
  "replies, or hostility aimed at someone other than the OP. When in doubt, do not flag. " +
  'Return JSON: {"flagged_ids": ["<id>", ...]}';

interface XUser {
  id: string;
  username: string;
}

interface XTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  in_reply_to_user_id?: string;
  public_metrics?: Record<string, number>;
}

interface XPage {
  data?: XTweet[];
  includes?: { users?: XUser[] };
  meta?: { next_token?: string };
}

interface Response {
  id: string;
  text: string;
  username: string;
  replyingToOp: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return value;
}

function getBearerToken(): string {
  const token = requireEnv("X_BEARER_TOKEN").replace(/^Bearer\s+/i, "");
  if (!/%[0-9A-Fa-f]{2}/.test(token)) return token;
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function xGet<T>(path: string, query: Record<string, string>): Promise<T> {
  const endpoint = `${API_BASE}${path}?${new URLSearchParams(query).toString()}`;
  const headers = { Authorization: `Bearer ${getBearerToken()}` };

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(endpoint, { headers });
    if (res.ok) return (await res.json()) as T;

    const reset = Number(res.headers.get("x-rate-limit-reset") ?? "0");
    const waitSec = reset > 0 ? Math.max(reset - Math.floor(Date.now() / 1000), 1) : 15;
    if (res.status === 429 && attempt < 3 && waitSec <= MAX_RATE_LIMIT_WAIT_SEC) {
      console.error(`Rate limited, waiting ${waitSec}s...`);
      await sleep(waitSec * 1000 + 400);
      continue;
    }

    const body = await res.text().catch(() => "");
    const retryHint = res.status === 429 ? ` (resets in ~${Math.ceil(waitSec / 60)} min)` : "";
    throw Object.assign(new Error(`HTTP ${res.status} on ${path}${retryHint}: ${body.slice(0, 200)}`), {
      status: res.status,
    });
  }
}

function parseArgs(argv: string[]): { tweetId: string; passes: number } {
  const input = argv.find((a) => !a.startsWith("--"));
  const passesIndex = argv.indexOf("--passes");
  const passes = passesIndex >= 0 ? Number(argv[passesIndex + 1]) : 3;
  if (!input) throw new Error("Usage: npm run scan -- <tweet-url-or-id> [--passes 3]");
  if (!Number.isInteger(passes) || passes < 1) throw new Error("--passes must be a positive integer");

  const match = input.match(/status(?:es)?\/(\d+)/) ?? input.match(/^(\d+)$/);
  if (!match) throw new Error(`Could not parse a tweet id from "${input}"`);
  return { tweetId: match[1], passes };
}

interface Collected {
  results: Response[];
  incomplete?: string;
}

async function paginate(path: string, query: Record<string, string>, opId: string): Promise<Collected> {
  const results: Response[] = [];
  const seen = new Set<string>();
  const isSearch = path.includes("/search/");
  let nextToken: string | undefined;

  do {
    let page: XPage;
    try {
      page = await xGet<XPage>(path, {
        ...query,
        ...(nextToken ? { [isSearch ? "next_token" : "pagination_token"]: nextToken } : {}),
      });
    } catch (err) {
      if (results.length === 0) throw err;
      const status = (err as { status?: number }).status;
      return { results, incomplete: status === 429 ? "rate limited partway through" : "failed partway through" };
    }

    const users = new Map((page.includes?.users ?? []).map((u) => [u.id, u.username]));
    let added = 0;
    for (const tweet of page.data ?? []) {
      if (seen.has(tweet.id)) continue;
      seen.add(tweet.id);
      if (!tweet.author_id || tweet.author_id === opId) continue;
      const username = users.get(tweet.author_id);
      if (!username) continue;
      const replyingToOp = !tweet.in_reply_to_user_id || tweet.in_reply_to_user_id === opId;
      results.push({ id: tweet.id, text: tweet.text, username, replyingToOp });
      added++;
    }
    console.error(`  ${path}: ${results.length} collected`);
    // The quote_tweets endpoint can keep handing out next_tokens for pages with nothing new.
    nextToken = added > 0 ? page.meta?.next_token : undefined;
    if (nextToken && isSearch) await sleep(1100);
  } while (nextToken);

  return { results };
}

const RESPONSE_FIELDS = {
  max_results: "100",
  "tweet.fields": "author_id,in_reply_to_user_id",
  expansions: "author_id",
  "user.fields": "username",
};

async function fetchReplies(tweetId: string, opId: string): Promise<Collected> {
  const query = { ...RESPONSE_FIELDS, query: `conversation_id:${tweetId}` };
  try {
    return await paginate("/tweets/search/all", query, opId);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 401 && status !== 403) throw err;
    console.error("Full-archive search isn't available on this API plan; using last-7-days search instead.");
    return paginate("/tweets/search/recent", query, opId);
  }
}

async function fetchQuotes(tweetId: string, opId: string): Promise<Collected> {
  return paginate(`/tweets/${tweetId}/quote_tweets`, RESPONSE_FIELDS, opId);
}

async function classify(openai: OpenAI, original: string, responses: Response[]): Promise<Set<string>> {
  const flagged = new Set<string>();

  for (let i = 0; i < responses.length; i += BATCH_SIZE) {
    const batch = responses.slice(i, i + BATCH_SIZE);
    const completion = await openai.chat.completions.create({
      model: MODEL,
      // Reasoning models reject custom temperature.
      ...(MODEL.startsWith("gpt-4") ? { temperature: 0 } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            original_post: original,
            responses: batch.map((r) => ({ id: r.id, text: r.text, replying_to_op: r.replyingToOp })),
          }),
        },
      ],
    });

    let ids = new Set<string>();
    try {
      const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as { flagged_ids?: string[] };
      ids = new Set(parsed.flagged_ids ?? []);
    } catch {
      console.error("  classifier returned invalid JSON for one batch; treating it as no flags");
    }
    for (const r of batch) if (ids.has(r.id)) flagged.add(r.username);
  }

  return flagged;
}

async function main() {
  const { tweetId, passes } = parseArgs(process.argv.slice(2));
  const openai = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });

  const { data: tweet, includes } = await xGet<{ data: XTweet; includes?: { users?: XUser[] } }>(
    `/tweets/${tweetId}`,
    { "tweet.fields": "created_at,public_metrics,author_id", expansions: "author_id", "user.fields": "username" }
  );
  const op = includes?.users?.find((u) => u.id === tweet.author_id);
  const opId = tweet.author_id ?? "";

  console.log("=== Tweet ===");
  console.log(`URL:     https://x.com/${op?.username ?? "i"}/status/${tweet.id}`);
  console.log(`Author:  @${op?.username ?? "unknown"}`);
  console.log(`Posted:  ${tweet.created_at}`);
  console.log(`Metrics: ${JSON.stringify(tweet.public_metrics)}\n`);

  const replies = await fetchReplies(tweetId, opId);
  await sleep(1100);
  const quotes = await fetchQuotes(tweetId, opId).catch(
    (err: Error & { status?: number }): Collected => ({
      results: [],
      incomplete: err.status === 429 ? "skipped: rate limited, try again in ~15 min" : `skipped: ${err.message}`,
    })
  );
  const note = (c: Collected) => (c.incomplete ? ` (${c.incomplete})` : "");

  const all = [...replies.results, ...quotes.results];
  console.error(`Classifying ${all.length} responses with ${MODEL}, ${passes} pass(es)...`);
  const results = await Promise.all(Array.from({ length: passes }, () => classify(openai, tweet.text, all)));
  const flagged = [...results[0]].filter((u) => results.every((r) => r.has(u))).sort();
  console.error(`Flags per pass: ${results.map((r) => r.size).join(", ")} (keeping accounts flagged in every pass)`);

  console.log("=== Scan ===");
  console.log(`Replies scanned:      ${replies.results.length}${note(replies)}`);
  console.log(`Quote tweets scanned: ${quotes.results.length}${note(quotes)}`);
  console.log(`Plain retweets:       ${tweet.public_metrics?.retweet_count ?? "unknown"} (no text to scan)`);
  console.log(`Accounts to block:    ${flagged.length}\n`);
  for (const username of flagged) console.log(`https://x.com/${username}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
