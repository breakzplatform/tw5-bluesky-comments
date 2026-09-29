// Run with: node --test test/
"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var thread = require("../lib/thread.js");

var DID = "did:plc:z72i7hdynmk6r22z27h6tvur";
var HIDDEN = ["!hide", "porn", "spam"];

function post(rkey, options) {
	options = options || {};
	return {
		uri: thread.buildPostUri(DID, rkey),
		author: { did: DID, handle: "someone.example.com", labels: options.authorLabels || [] },
		record: { text: rkey, createdAt: options.createdAt || "2026-01-01T00:00:00Z" },
		labels: options.labels || [],
		likeCount: options.likes || 0,
		replyCount: options.replyCount || 0
	};
}

function reply(rkey, options, replies) {
	return { $type: "app.bsky.feed.defs#threadViewPost", post: post(rkey, options), replies: replies };
}

test("parses bsky.app links with a handle", function () {
	assert.deepEqual(thread.parsePostLink("https://bsky.app/profile/Someone.Bsky.Social/post/3mupeo3so622k"),
		{ handle: "someone.bsky.social", rkey: "3mupeo3so622k" });
});

test("parses links with a DID, trailing slash and query", function () {
	assert.deepEqual(thread.parsePostLink(" https://bsky.app/profile/" + DID + "/post/3abc/?ref=x "),
		{ did: DID, rkey: "3abc" });
});

test("parses at:// URIs and rejects other collections", function () {
	assert.deepEqual(thread.parsePostLink("at://" + DID + "/app.bsky.feed.post/3abc"), { did: DID, rkey: "3abc" });
	assert.equal(thread.parsePostLink("at://" + DID + "/app.bsky.feed.like/3abc"), null);
});

test("rejects links that are not posts", function () {
	["", "https://bsky.app/profile/bsky.app", "https://example.com/post/1", "javascript:alert(1)",
		"https://bsky.app/profile/not a handle/post/3abc", "https://bsky.app/profile/%E0%A4%A/post/3abc"]
		.forEach(function (link) {
			assert.equal(thread.parsePostLink(link), null, link);
		});
});

test("segments text by UTF-8 byte offsets", function () {
	// "é" and the emoji take more bytes than JavaScript characters
	var text = "olá 🦋 @bsky.app see https://x.dev";
	var bytes = Buffer.from(text);
	var mentionStart = bytes.indexOf("@bsky.app");
	var linkStart = bytes.indexOf("https://x.dev");
	var segments = thread.segmentText(text, [
		{ index: { byteStart: linkStart, byteEnd: bytes.length }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://x.dev" }] },
		{ index: { byteStart: mentionStart, byteEnd: mentionStart + 9 }, features: [{ $type: "app.bsky.richtext.facet#mention", did: DID }] }
	]);
	assert.deepEqual(segments, [
		{ text: "olá 🦋 " },
		{ text: "@bsky.app", feature: { type: "mention", did: DID } },
		{ text: " see " },
		{ text: "https://x.dev", feature: { type: "link", uri: "https://x.dev" } }
	]);
});

test("drops unsafe, overlapping and out of range facets", function () {
	var segments = thread.segmentText("click me now", [
		{ index: { byteStart: 0, byteEnd: 5 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "javascript:alert(1)" }] },
		{ index: { byteStart: 6, byteEnd: 8 }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: "me" }] },
		{ index: { byteStart: 7, byteEnd: 12 }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: "overlap" }] },
		{ index: { byteStart: 9, byteEnd: 99 }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: "past" }] }
	]);
	assert.deepEqual(segments, [
		{ text: "click " },
		{ text: "me", feature: { type: "tag", tag: "me" } },
		{ text: " now" }
	]);
});

test("classifies labels on the post and on the author, honoring negation", function () {
	assert.equal(thread.classifyPost(post("a"), HIDDEN), "visible");
	assert.equal(thread.classifyPost(post("a", { labels: [{ val: "porn" }] }), HIDDEN), "moderated");
	assert.equal(thread.classifyPost(post("a", { authorLabels: [{ val: "spam" }] }), HIDDEN), "moderated");
	assert.equal(thread.classifyPost(post("a", { labels: [{ val: "porn" }, { val: "porn", neg: true }] }), HIDDEN), "visible");
	assert.equal(thread.classifyPost(post("a", { authorLabels: [{ val: "!no-unauthenticated" }] }), HIDDEN), "signed-in-only");
});

test("builds the reply tree, keeping hidden replies only as context for visible ones", function () {
	var response = {
		thread: {
			$type: "app.bsky.feed.defs#threadViewPost",
			post: post("root", { replyCount: 4 }),
			replies: [
				reply("late", { createdAt: "2026-01-03T00:00:00Z", replyCount: 1 }, [
					reply("nested", { createdAt: "2026-01-04T00:00:00Z", replyCount: 2 }, [])
				]),
				reply("early", { createdAt: "2026-01-02T00:00:00Z" }, []),
				reply("gated", {}, []),
				reply("spam", { labels: [{ val: "spam" }] }, []),
				reply("hidden-parent", { createdAt: "2026-01-05T00:00:00Z", authorLabels: [{ val: "!no-unauthenticated" }], replyCount: 1 }, [
					reply("visible-child", { createdAt: "2026-01-06T00:00:00Z" }, [])
				]),
				{ $type: "app.bsky.feed.defs#notFoundPost", uri: "at://x" },
				{ $type: "app.bsky.feed.defs#blockedPost", uri: "at://y" },
				{ $type: "app.bsky.feed.defs#somethingNew" },
				{ $type: "app.bsky.feed.defs#threadViewPost", post: { uri: "at://x/app.bsky.feed.post/1", author: { did: "javascript:alert(1)" }, record: {} } }
			]
		},
		threadgate: { record: { hiddenReplies: [thread.buildPostUri(DID, "gated")] } }
	};
	var root = thread.buildThread(response, { maxDepth: 2, sort: "oldest", hiddenLabels: HIDDEN });
	assert.equal(root.kind, "visible");
	assert.deepEqual(root.replies.map(function (node) {
		return node.post ? node.post.record.text : node.kind;
	}), ["early", "late", "hidden-parent"]);
	assert.equal(root.replies[2].kind, "signed-in-only");
	assert.equal(root.replies[2].replies[0].kind, "visible");
	// spam, not found, blocked and malformed; the gated reply is not counted
	assert.equal(root.omitted, 4);
	var nested = root.replies[1].replies[0];
	assert.equal(nested.post.record.text, "nested");
	assert.equal(nested.truncated, true);
	assert.equal(root.replies[1].truncated, false);
});

test("sorts direct replies by likes or newest, nested ones oldest first", function () {
	var response = {
		thread: {
			$type: "app.bsky.feed.defs#threadViewPost",
			post: post("root"),
			replies: [
				reply("a", { likes: 1, createdAt: "2026-01-01T00:00:00Z" }, [
					reply("a2", { createdAt: "2026-01-05T00:00:00Z" }),
					reply("a1", { createdAt: "2026-01-04T00:00:00Z" })
				]),
				reply("b", { likes: 5, createdAt: "2026-01-02T00:00:00Z" }, [])
			]
		}
	};
	var texts = function (nodes) {
		return nodes.map(function (node) {
			return node.post.record.text;
		});
	};
	var byLikes = thread.buildThread(response, { maxDepth: 3, sort: "likes", hiddenLabels: [] });
	assert.deepEqual(texts(byLikes.replies), ["b", "a"]);
	assert.deepEqual(texts(byLikes.replies[1].replies), ["a1", "a2"]);
	var newest = thread.buildThread(response, { maxDepth: 3, sort: "newest", hiddenLabels: [] });
	assert.deepEqual(texts(newest.replies), ["b", "a"]);
});

test("reports missing and blocked root posts", function () {
	assert.equal(thread.buildThread({ thread: { $type: "app.bsky.feed.defs#notFoundPost" } }, { maxDepth: 1 }).kind, "not-found");
	assert.equal(thread.buildThread({ thread: { $type: "app.bsky.feed.defs#blockedPost" } }, { maxDepth: 1 }).kind, "blocked");
	assert.equal(thread.buildThread({}, { maxDepth: 1 }).kind, "not-found");
});

test("isWebUrl accepts only http and https links", function () {
	assert.equal(thread.isWebUrl("https://example.com/a"), true);
	assert.equal(thread.isWebUrl("HTTP://example.com"), true);
	assert.equal(thread.isWebUrl("javascript:alert(1)"), false);
	assert.equal(thread.isWebUrl("data:text/html,x"), false);
	assert.equal(thread.isWebUrl("https://exa mple.com"), false);
	assert.equal(thread.isWebUrl(null), false);
});

test("segmentText drops link and mention facets with unsafe targets", function () {
	var segments = thread.segmentText("bad link", [
		{ index: { byteStart: 0, byteEnd: 3 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "javascript:alert(1)" }] },
		{ index: { byteStart: 4, byteEnd: 8 }, features: [{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:x/../evil" }] }
	]);
	assert.ok(segments.every(function (segment) { return !segment.feature; }));
	assert.equal(segments.map(function (segment) { return segment.text; }).join(""), "bad link");
});
