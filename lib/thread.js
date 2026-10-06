/*\
title: $:/plugins/breakzplatform/bluesky-comments/lib/thread.js
type: application/javascript
module-type: library

Parse links to Bluesky posts and turn the thread returned by the AppView into
a reply tree ready to display

No DOM and no network access here, so the tests can run it under plain Node

\*/
(function () {

	/*jslint node: true, browser: true */
	"use strict";

	var POST_COLLECTION = "app.bsky.feed.post";
	var DID_PATTERN = /^did:[a-z]+:[a-zA-Z0-9._:%-]+$/;
	var HANDLE_PATTERN = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
	var RECORD_KEY_PATTERN = /^[a-zA-Z0-9._~:-]{1,512}$/;
	var AT_URI_PATTERN = /^at:\/\/([^\/]+)\/([^\/]+)\/([^\/?#]+)$/;
	// bsky.app and most other clients share the /profile/<actor>/post/<rkey> layout
	var WEB_LINK_PATTERN = /^https?:\/\/[^\/?#]+\/profile\/([^\/?#]+)\/post\/([^\/?#]+)\/?(?:[?#].*)?$/;

	var THREAD_POST = "app.bsky.feed.defs#threadViewPost";
	var NOT_FOUND_POST = "app.bsky.feed.defs#notFoundPost";
	var BLOCKED_POST = "app.bsky.feed.defs#blockedPost";

	// Self-label set by people who opted out of showing their posts to
	// logged-out visitors, which is what every reader of the wiki is
	var SIGNED_IN_ONLY_LABEL = "!no-unauthenticated";

	function safeDecode(text) {
		try {
			return decodeURIComponent(text);
		} catch (error) {
			return null;
		}
	}

	/*
	Returns {did, rkey} or {handle, rkey}, or null when the link is not a post
	*/
	exports.parsePostLink = function (link) {
		var text = (link || "").trim();
		var actor, recordKey, match;
		if ((match = AT_URI_PATTERN.exec(text))) {
			if (match[2] !== POST_COLLECTION) return null;
			actor = match[1];
			recordKey = match[3];
		} else if ((match = WEB_LINK_PATTERN.exec(text))) {
			actor = safeDecode(match[1]);
			recordKey = safeDecode(match[2]);
		} else {
			return null;
		}
		if (!actor || !recordKey || !RECORD_KEY_PATTERN.test(recordKey)) return null;
		actor = actor.replace(/^@/, "");
		if (DID_PATTERN.test(actor)) return { did: actor, rkey: recordKey };
		if (HANDLE_PATTERN.test(actor)) return { handle: actor.toLowerCase(), rkey: recordKey };
		return null;
	};

	exports.isDid = function (text) {
		return DID_PATTERN.test(text || "");
	};

	exports.buildPostUri = function (did, recordKey) {
		return "at://" + did + "/" + POST_COLLECTION + "/" + recordKey;
	};

	exports.recordKeyFromUri = function (uri) {
		var match = AT_URI_PATTERN.exec(uri || "");
		return match ? match[3] : null;
	};

	exports.isWebUrl = function (url) {
		return /^https?:\/\/[^\s]+$/i.test(url || "");
	};

	function pickFeature(features) {
		var picked = null;
		(features || []).some(function (feature) {
			switch (feature && feature.$type) {
				case "app.bsky.richtext.facet#link":
					if (exports.isWebUrl(feature.uri)) picked = { type: "link", uri: feature.uri };
					break;
				case "app.bsky.richtext.facet#mention":
					if (DID_PATTERN.test(feature.did || "")) picked = { type: "mention", did: feature.did };
					break;
				case "app.bsky.richtext.facet#tag":
					if (typeof feature.tag === "string" && feature.tag) picked = { type: "tag", tag: feature.tag };
					break;
			}
			return picked !== null;
		});
		return picked;
	}

	function isUsableFacet(facet) {
		var index = facet && facet.index;
		return index && typeof index.byteStart === "number" && typeof index.byteEnd === "number" &&
			index.byteStart >= 0 && index.byteEnd > index.byteStart;
	}

	/*
	Split the post text into plain runs and runs with a link, mention or tag.
	Facet offsets count UTF-8 bytes, not JavaScript characters, so the text is
	sliced as bytes. Facets that overlap or point past the text are dropped
	*/
	exports.segmentText = function (text, facets) {
		text = text || "";
		var usable = arrayOrEmpty(facets).filter(isUsableFacet).sort(function (a, b) {
			return a.index.byteStart - b.index.byteStart;
		});
		if (!usable.length) return text ? [{ text: text }] : [];
		var bytes = new TextEncoder().encode(text);
		var decoder = new TextDecoder();
		var slice = function (start, end) {
			return decoder.decode(bytes.subarray(start, end));
		};
		var segments = [];
		var cursor = 0;
		usable.forEach(function (facet) {
			var start = facet.index.byteStart;
			var end = facet.index.byteEnd;
			var feature = pickFeature(facet.features);
			if (!feature || start < cursor || end > bytes.length) return;
			if (start > cursor) segments.push({ text: slice(cursor, start) });
			segments.push({ text: slice(start, end), feature: feature });
			cursor = end;
		});
		if (cursor < bytes.length) segments.push({ text: slice(cursor, bytes.length) });
		return segments;
	};

	/*
	Active label values of a post and its author. A label with neg set
	retracts an earlier label with the same value from the same source,
	and a label past its exp date no longer applies
	*/
	exports.getLabels = function (post, now) {
		var active = {};
		var labels = arrayOrEmpty(post && post.labels).concat(arrayOrEmpty(post && post.author && post.author.labels));
		var time = now === undefined ? Date.now() : now;
		labels.forEach(function (label) {
			if (!label || typeof label.val !== "string") return;
			if (label.exp && Date.parse(label.exp) <= time) return;
			var key = String(label.src) + " " + label.val;
			if (label.neg) {
				delete active[key];
			} else {
				active[key] = label.val;
			}
		});
		var values = [];
		Object.keys(active).forEach(function (key) {
			if (values.indexOf(active[key]) === -1) values.push(active[key]);
		});
		return values;
	};

	function arrayOrEmpty(value) {
		return Array.isArray(value) ? value : [];
	}

	/*
	"visible", "signed-in-only" or "moderated"
	*/
	exports.classifyPost = function (post, hiddenLabels) {
		var labels = exports.getLabels(post);
		if (labels.indexOf(SIGNED_IN_ONLY_LABEL) !== -1) return "signed-in-only";
		var moderated = labels.some(function (label) {
			return hiddenLabels.indexOf(label) !== -1;
		});
		return moderated ? "moderated" : "visible";
	};

	// Links to posts and profiles are built from these fields
	function isWellFormed(post) {
		var recordKey = post && exports.recordKeyFromUri(post.uri);
		return !!(recordKey && RECORD_KEY_PATTERN.test(recordKey) && post.author &&
			DID_PATTERN.test(post.author.did || "") && post.record && typeof post.record === "object");
	}

	function timestamp(node) {
		var date = node.post && node.post.record && Date.parse(node.post.record.createdAt);
		return typeof date === "number" && !isNaN(date) ? date : Infinity;
	}

	var COMPARATORS = {
		oldest: function (a, b) {
			return timestamp(a) - timestamp(b);
		},
		newest: function (a, b) {
			return timestamp(b) - timestamp(a);
		},
		likes: function (a, b) {
			var likesA = (a.post && a.post.likeCount) || 0;
			var likesB = (b.post && b.post.likeCount) || 0;
			return likesB - likesA || timestamp(a) - timestamp(b);
		}
	};

	function sortNodes(nodes, order) {
		var comparator = COMPARATORS[order] || COMPARATORS.oldest;
		// Array.prototype.sort is only guaranteed stable since ES2019
		return nodes.map(function (node, position) {
			return { node: node, position: position };
		}).sort(function (a, b) {
			var result = comparator(a.node, b.node);
			return (result === result && result !== 0) ? result : a.position - b.position;
		}).map(function (entry) {
			return entry.node;
		});
	}

	function buildNodes(replies, depth, options) {
		var nodes = [];
		(replies || []).forEach(function (reply) {
			switch (reply && reply.$type) {
				case THREAD_POST:
					if (!isWellFormed(reply.post)) {
						options.omitted += 1;
						return;
					}
					if (options.hiddenReplies.indexOf(reply.post.uri) !== -1) return;
					var kind = exports.classifyPost(reply.post, options.hiddenLabels);
					var children = depth < options.maxDepth ? buildNodes(reply.replies, depth + 1, options) : [];
					// A hidden reply only stays, as a notice, to give context to visible answers below it
					if (kind !== "visible" && !children.length) {
						options.omitted += 1;
						return;
					}
					nodes.push({
						kind: kind,
						post: reply.post,
						replies: children,
						// The AppView leaves out replies below the requested depth
						truncated: (reply.post.replyCount || 0) > (depth < options.maxDepth ? (reply.replies || []).length : 0)
					});
					break;
				case NOT_FOUND_POST:
				case BLOCKED_POST:
					options.omitted += 1;
					break;
			}
		});
		// Conversations below the first level always read oldest first
		return sortNodes(nodes, depth === 1 ? options.sort : "oldest");
	}

	/*
	Turn the output of app.bsky.feed.getPostThread into
	{kind, post, replies: [node], omitted}. The root kind is "visible",
	"signed-in-only", "moderated", "not-found" or "blocked". Reply nodes are
	{kind, post, replies, truncated}, with the kinds a post can have; hidden,
	deleted and blocked replies without visible answers are left out and
	counted in omitted.
	Options: maxDepth, sort ("oldest", "newest" or "likes"), hiddenLabels
	*/
	exports.buildThread = function (response, options) {
		var thread = response && response.thread;
		var settings = {
			maxDepth: options.maxDepth,
			sort: options.sort,
			hiddenLabels: options.hiddenLabels || [],
			hiddenReplies: [],
			omitted: 0
		};
		if (!thread || thread.$type === NOT_FOUND_POST) return { kind: "not-found", replies: [] };
		if (thread.$type === BLOCKED_POST) return { kind: "blocked", replies: [] };
		if (thread.$type !== THREAD_POST || !isWellFormed(thread.post)) return { kind: "not-found", replies: [] };
		// Replies the author hid through the thread gate stay hidden here too
		var gate = response.threadgate || thread.post.threadgate;
		var hidden = gate && gate.record && gate.record.hiddenReplies;
		if (Array.isArray(hidden)) settings.hiddenReplies = hidden;
		var replies = buildNodes(thread.replies, 1, settings);
		return {
			kind: exports.classifyPost(thread.post, settings.hiddenLabels),
			post: thread.post,
			replies: replies,
			omitted: settings.omitted
		};
	};

})();
