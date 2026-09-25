# x-block-scan

Find the accounts to block on one of your X posts without reading the replies.

Paste in a post URL. The script collects the replies and quote tweets, has an LLM flag the ones that are **directly aggressive or hateful toward you**, and prints only the profile links of those accounts. It never shows you what anyone wrote.

```
=== Scan ===
Replies scanned:      142
Quote tweets scanned: 17
Plain retweets:       2 (no text to scan)
Accounts to block:    15

https://x.com/someone
https://x.com/someone_else
...
```

## Why

If a post goes semi-viral, you can end up reading every hostile reply just to decide who to block. This does the reading for you so you only have to click Block.

## What gets flagged

It's deliberately conservative. It flags:

- insults and name-calling aimed at you
- threats and harassment
- sexual or degrading remarks
- attacks on your gender, race, appearance, or other identity

It does **not** flag:

- disagreement, even blunt disagreement
- sarcasm, snark, passive-aggressiveness, or condescension
- criticism of your argument
- frustration directed at someone else, like a person you mention in your post
- replies to other people in the thread, unless they still clearly go after you

The classifier runs 3 times (configurable), and an account is listed only if **every** run flags it. That filters out one-off borderline calls.

## Privacy

- Reply and quote text is held in memory only and sent to the classifier. It's never printed, logged, or written to disk.
- The output is limited to your post's metadata, counts, and profile URLs.
- Your own replies in the thread are skipped.

## Setup

Requires Node 18+.

```bash
git clone https://github.com/ashemag/x-block-scan.git
cd x-block-scan
npm install
cp .env.example .env   # then fill in the keys
```

| Variable | Where to get it |
| --- | --- |
| `X_BEARER_TOKEN` | [X developer portal](https://developer.x.com/en/portal/dashboard): your app's bearer token |
| `OPENAI_API_KEY` | [OpenAI API keys](https://platform.openai.com/api-keys) |
| `OPENAI_MODEL` | Optional; defaults to `gpt-4o` |

## Usage

```bash
npm run scan -- https://x.com/you/status/1234567890
npm run scan -- 1234567890 --passes 5   # stricter: must be flagged in all 5 runs
```

## Notes on the X API

- **Replies** come from searching for `conversation_id:<post id>`. Full-archive search needs an API plan that includes it. Otherwise the script falls back to recent search, which only covers the **last 7 days**.
- **Quote tweets** come from the `quote_tweets` endpoint, which has a low rate limit. If it's rate-limited, the script skips quote tweets, says so, and you can rerun it in about 15 minutes.
- **Plain retweets** have no text, so they're counted but not judged.

## Using it with an AI coding agent

If you run this through Cursor, Claude Code, or a similar agent, give it these rules so it doesn't read the replies back to you:

```text
Run the X block scan on this tweet: <TWEET_URL>
  npm run scan -- "<TWEET_URL>"

Rules:
- NEVER show me, quote, summarize, or paraphrase the content of any reply or
  quote tweet. Don't print it, save it to a file, or put it in your messages.
  Only give me profile URLs and counts.
- Only flag people who are directly aggressive or hateful toward ME, not
  toward anyone I'm describing in the post.
- If X rate-limits the quote tweets, tell me and offer to rerun once the
  limit resets.
- Give me the final list as clickable https://x.com/<username> links.
```

## Caveats

LLM classification isn't perfect. Treat the list as a strong suggestion, not a verdict. If you want to double-check one account, open their profile rather than the thread.

## License

MIT
