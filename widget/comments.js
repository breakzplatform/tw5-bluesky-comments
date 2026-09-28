/*\
title: $:/plugins/breakzplatform/bluesky-comments/widget/comments.js
type: application/javascript
module-type: widget

Display the replies to a Bluesky post as comments on a tiddler

\*/
(function () {

	/*jslint node: true, browser: true */
	/*global $tw: false */
	"use strict";

	var Widget = require("$:/core/modules/widgets/widget.js").widget;
	var thread = require("$:/plugins/breakzplatform/bluesky-comments/lib/thread.js");

	var PLUGIN_PREFIX = "$:/plugins/breakzplatform/bluesky-comments/";
	var CONFIG_PREFIX = "$:/config/breakzplatform/bluesky-comments/";
	var LANGUAGE_TIDDLER = PLUGIN_PREFIX + "language";
	var POST_FIELD = "bluesky-post";
	var RETRY_MESSAGE = "tm-bluesky-comments-retry";

	var DEFAULT_API = "https://public.api.bsky.app";
	var DEFAULT_APP = "https://bsky.app";
	var DEFAULT_DEPTH = 6;
	var MAX_DEPTH = 20;
	var DEFAULT_HIDDEN_LABELS = "!hide !warn porn sexual nudity graphic-media gore spam";
	// Threads are fetched again when reopened after this long
	var CACHE_LIFETIME = 5 * 60 * 1000;
	var REQUEST_TIMEOUT = 20 * 1000;

	// Shared by every instance of the widget, so that closing and reopening
	// the comments, or refreshing the story river, does not fetch again
	var threadCache = {};
	var didCache = {};

	var BlueskyCommentsWidget = function (parseTreeNode, options) {
		this.initialise(parseTreeNode, options);
		var self = this;
		this.addEventListener(RETRY_MESSAGE, function () {
			delete threadCache[self.cacheKey];
			self.refreshSelf();
			return false;
		});
	};

	BlueskyCommentsWidget.prototype = new Widget();

	BlueskyCommentsWidget.prototype.render = function (parent, nextSibling) {
		this.parentDomNode = parent;
		this.computeAttributes();
		this.execute();

		this.wrapper = this.document.createElement("div");
		this.wrapper.className = "bsky-comments";
		// Lets the toolbar button find the comments of its tiddler to scroll to them
		this.wrapper.setAttribute("data-tiddler-title", this.tiddlerTitle);
		parent.insertBefore(this.wrapper, nextSibling);
		this.domNodes.push(this.wrapper);
		this.renderContent();

		// Nothing to fetch when generating static pages
		if (!$tw.browser || !this.postRef) return;
		var entry = threadCache[this.cacheKey];
		// load() also subscribes to a request another instance already started
		if (!entry || entry.loading || entry.expires < Date.now()) this.load();
	};

	BlueskyCommentsWidget.prototype.execute = function () {
		this.tiddlerTitle = this.getAttribute("tiddler", this.getVariable("currentTiddler"));
		this.postLink = this.getAttribute("post", this.getPostField()).trim();
		this.postRef = thread.parsePostLink(this.postLink);
		this.apiBase = this.getConfig("api", DEFAULT_API).replace(/\/+$/, "");
		this.appBase = this.getConfig("app", DEFAULT_APP).replace(/\/+$/, "");
		var depth = parseInt(this.getConfig("depth", ""), 10);
		this.maxDepth = isNaN(depth) ? DEFAULT_DEPTH : Math.min(Math.max(depth, 1), MAX_DEPTH);
		this.sort = this.getConfig("sort", "oldest");
		this.showCounts = this.getConfig("counts", "yes") !== "no";
		this.hiddenLabels = this.getConfig("hidden-labels", DEFAULT_HIDDEN_LABELS).split(/\s+/).filter(Boolean);
		this.cacheKey = [this.apiBase, this.postLink, this.maxDepth].join(" ");
	};

	BlueskyCommentsWidget.prototype.getPostField = function () {
		var tiddler = this.wiki.getTiddler(this.tiddlerTitle);
		return (tiddler && tiddler.fields[POST_FIELD]) || "";
	};

	BlueskyCommentsWidget.prototype.getConfig = function (name, fallback) {
		var text = this.wiki.getTiddlerText(CONFIG_PREFIX + name);
		text = (text || "").trim();
		return text || fallback;
	};

	BlueskyCommentsWidget.prototype.getText = function (key) {
		return this.wiki.extractTiddlerDataItem(LANGUAGE_TIDDLER, key, key);
	};

	BlueskyCommentsWidget.prototype.renderContent = function () {
		if (this.destroyChildren) this.destroyChildren({ removeDOMNodes: false });
		while (this.wrapper.firstChild) {
			this.wrapper.removeChild(this.wrapper.firstChild);
		}
		this.makeChildWidgets(this.buildContent());
		this.renderChildren(this.wrapper, null);
	};

	// Whether the widget is still on the page once a request comes back
	BlueskyCommentsWidget.prototype.isAttached = function () {
		return this.document.documentElement.contains(this.wrapper);
	};

	/* Network */

	BlueskyCommentsWidget.prototype.request = function (method, parameters, callback) {
		var query = Object.keys(parameters).map(function (name) {
			return name + "=" + encodeURIComponent(parameters[name]);
		}).join("&");
		var finished = false;
		var xhr = $tw.utils.httpRequest({
			url: this.apiBase + "/xrpc/" + method + "?" + query,
			callback: function (error, text, request) {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				var body = null;
				try {
					body = JSON.parse(text);
				} catch (parseError) {
					// The AppView answers errors in JSON too; anything else is a proxy or network failure
				}
				if (!error && body) {
					callback(null, body);
					return;
				}
				callback({
					status: request ? request.status : 0,
					name: body && body.error
				});
			}
		});
		// XMLHttpRequest has no timeout by default, and a stalled connection
		// would leave the comments loading forever
		var timer = setTimeout(function () {
			if (finished) return;
			finished = true;
			if (xhr && xhr.abort) xhr.abort();
			callback({ status: 0 });
		}, REQUEST_TIMEOUT);
	};

	BlueskyCommentsWidget.prototype.resolveDid = function (callback) {
		var handle = this.postRef.handle;
		if (!handle) return callback(null, this.postRef.did);
		if (didCache[handle]) return callback(null, didCache[handle]);
		this.request("com.atproto.identity.resolveHandle", { handle: handle }, function (error, body) {
			if (error) return callback(error);
			if (!thread.isDid(body.did)) return callback({ status: 200, name: "InvalidResponse" });
			didCache[handle] = body.did;
			callback(null, body.did);
		});
	};

	BlueskyCommentsWidget.prototype.load = function () {
		var self = this;
		var key = this.cacheKey;
		var entry = threadCache[key];
		if (entry && entry.loading) {
			entry.waiting.push(function () {
				self.onLoaded();
			});
			return;
		}
		entry = threadCache[key] = { loading: true, waiting: [], expires: Infinity };
		var finish = function (result) {
			threadCache[key] = { result: result, expires: Date.now() + (result.error === "rate-limit" ? 0 : CACHE_LIFETIME) };
			self.onLoaded();
			entry.waiting.forEach(function (notify) {
				notify();
			});
		};
		this.resolveDid(function (error, did) {
			if (error) return finish({ error: self.describeError(error, true) });
			self.request("app.bsky.feed.getPostThread", {
				uri: thread.buildPostUri(did, self.postRef.rkey),
				depth: self.maxDepth,
				parentHeight: 0
			}, function (error, body) {
				finish(error ? { error: self.describeError(error, false) } : { response: body });
			});
		});
	};

	BlueskyCommentsWidget.prototype.describeError = function (error, resolvingHandle) {
		if (error.status === 429) return "rate-limit";
		if (error.name === "NotFound" || (resolvingHandle && error.status === 400)) return "not-found";
		if (error.status === 0) return "network";
		return "unavailable";
	};

	BlueskyCommentsWidget.prototype.onLoaded = function () {
		if (this.isAttached()) this.renderContent();
	};

	/* Parse tree construction. Everything from the API goes in as text nodes
	or attribute values, never as markup */

	function element(tag, className, children, attributes) {
		var node = { type: "element", tag: tag, attributes: {}, children: children || [] };
		if (className) node.attributes["class"] = { type: "string", value: className };
		$tw.utils.each(attributes || {}, function (value, name) {
			node.attributes[name] = { type: "string", value: String(value) };
		});
		return node;
	}

	function text(content) {
		return { type: "text", text: content };
	}

	function externalLink(href, className, children, title) {
		var attributes = { href: href, target: "_blank", rel: "noopener noreferrer nofollow ugc" };
		if (title) attributes.title = title;
		return element("a", className, children, attributes);
	}

	BlueskyCommentsWidget.prototype.format = function (key, values) {
		var result = this.getText(key);
		$tw.utils.each(values, function (value, name) {
			result = result.split("$" + name + "$").join(String(value));
		});
		return result;
	};

	BlueskyCommentsWidget.prototype.countText = function (count, singularKey, pluralKey) {
		return this.format(count === 1 ? singularKey : pluralKey, { count: count });
	};

	// DIDs, handles and record keys are limited to URL-safe characters by
	// the protocol and checked by the thread library, so they go in unencoded
	BlueskyCommentsWidget.prototype.profileUrl = function (did) {
		return this.appBase + "/profile/" + did;
	};

	BlueskyCommentsWidget.prototype.postUrl = function (post) {
		return this.profileUrl(post.author.did) + "/post/" + thread.recordKeyFromUri(post.uri);
	};

	// The link as written in the field may point to another client, or be an
	// at:// URI, so build one for the configured app
	BlueskyCommentsWidget.prototype.rootUrl = function () {
		return this.profileUrl(this.postRef.did || this.postRef.handle) + "/post/" + this.postRef.rkey;
	};

	BlueskyCommentsWidget.prototype.message = function (key, extraClass, children) {
		return element("p", "bsky-comments-message" + (extraClass ? " " + extraClass : ""), [text(this.getText(key))].concat(children || []));
	};

	BlueskyCommentsWidget.prototype.buildContent = function () {
		if (!this.postRef) {
			return [this.message(this.postLink ? "Error/InvalidLink" : "Error/MissingLink", "bsky-comments-warning")];
		}
		var replyLink = externalLink(this.rootUrl(), "bsky-comments-reply-link", [text(this.getText("ReplyOnBluesky"))]);
		if (!$tw.browser) return [element("p", "bsky-comments-message", [replyLink])];

		var entry = threadCache[this.cacheKey];
		if (!entry || entry.loading) return [this.message("Loading", "bsky-comments-loading")];
		if (entry.result.error) return this.buildError(entry.result.error);

		var root = thread.buildThread(entry.result.response, {
			maxDepth: this.maxDepth,
			sort: this.sort,
			hiddenLabels: this.hiddenLabels
		});
		switch (root.kind) {
			case "not-found":
				return [this.message("Error/NotFound", "bsky-comments-warning")];
			case "blocked":
				return [this.message("Error/Blocked", "bsky-comments-warning")];
			case "signed-in-only":
			case "moderated":
				return [this.message("Error/RootHidden", "bsky-comments-warning", [text(" "), replyLink])];
		}
		var content = [this.buildHeader(root.post, replyLink)];
		if (root.replies.length) {
			content.push(element("div", "bsky-comments-list", root.replies.map(this.buildNode, this)));
		} else if (!root.omitted) {
			content.push(this.message("NoReplies"));
		}
		if (root.omitted) {
			content.push(element("p", "bsky-comments-message bsky-comments-omitted", [
				externalLink(this.rootUrl(), "", [text(this.countText(root.omitted, "Omitted/One", "Omitted/Many"))])
			]));
		}
		return content;
	};

	BlueskyCommentsWidget.prototype.buildError = function (error) {
		var key = {
			"rate-limit": "Error/RateLimit",
			"not-found": "Error/NotFound",
			"network": "Error/Network"
		}[error] || "Error/Unavailable";
		var content = [this.message(key, "bsky-comments-warning")];
		if (error !== "not-found") {
			content.push({
				type: "button",
				attributes: {
					message: { type: "string", value: RETRY_MESSAGE },
					"class": { type: "string", value: "bsky-comments-retry" }
				},
				children: [text(this.getText("Retry"))]
			});
		}
		return content;
	};

	BlueskyCommentsWidget.prototype.buildHeader = function (post, replyLink) {
		var children = [];
		if (this.showCounts) {
			children.push(element("span", "bsky-comments-counts", [text([
				this.countText(post.replyCount || 0, "Count/Reply", "Count/Replies"),
				this.countText(post.repostCount || 0, "Count/Repost", "Count/Reposts"),
				this.countText(post.likeCount || 0, "Count/Like", "Count/Likes")
			].join(" · "))]));
		}
		children.push(replyLink);
		return element("div", "bsky-comments-header", children);
	};

	BlueskyCommentsWidget.prototype.buildNode = function (node) {
		var body;
		switch (node.kind) {
			case "visible":
				body = this.buildPost(node.post);
				break;
			case "signed-in-only":
				body = [this.message("Hidden/SignedInOnly", "bsky-comment-placeholder")];
				break;
			default:
				body = [this.message("Hidden/Moderated", "bsky-comment-placeholder")];
		}
		if (node.replies.length) {
			body.push(element("div", "bsky-comment-replies", node.replies.map(this.buildNode, this)));
		}
		if (node.truncated) {
			body.push(externalLink(this.postUrl(node.post), "bsky-comment-more", [text(this.getText("ContinueThread"))]));
		}
		return element("div", "bsky-comment", body);
	};

	BlueskyCommentsWidget.prototype.buildPost = function (post) {
		var author = post.author;
		var profile = this.profileUrl(author.did);
		var meta = [];
		if (thread.isWebUrl(author.avatar)) {
			meta.push(externalLink(profile, "bsky-comment-avatar-link", [
				element("img", "bsky-comment-avatar", [], { src: author.avatar, alt: "", loading: "lazy" })
			]));
		}
		meta.push(externalLink(profile, "bsky-comment-author", [
			element("span", "bsky-comment-name", [text(author.displayName || author.handle)]),
			text(" "),
			element("span", "bsky-comment-handle", [text("@" + author.handle)])
		]));
		var created = new Date(post.record && post.record.createdAt);
		if (!isNaN(created.getTime())) {
			meta.push(externalLink(this.postUrl(post), "bsky-comment-date", [
				element("time", "", [text($tw.utils.formatDateString(created, this.getText("DateFormat")))], {
					datetime: created.toISOString()
				})
			], created.toISOString()));
		}
		var content = [
			element("div", "bsky-comment-meta", meta),
			element("div", "bsky-comment-text", this.buildText(post.record || {}))
		];
		var embed = this.buildEmbed(post);
		if (embed) content.push(embed);
		var counts = [];
		if (post.likeCount) counts.push(this.countText(post.likeCount, "Count/Like", "Count/Likes"));
		if (post.repostCount) counts.push(this.countText(post.repostCount, "Count/Repost", "Count/Reposts"));
		if (this.showCounts && counts.length) {
			content.push(element("div", "bsky-comment-counts", [text(counts.join(" · "))]));
		}
		return content;
	};

	BlueskyCommentsWidget.prototype.buildText = function (record) {
		var self = this;
		return thread.segmentText(record.text, record.facets).map(function (segment) {
			var feature = segment.feature;
			if (!feature) return text(segment.text);
			switch (feature.type) {
				case "link":
					return externalLink(feature.uri, "bsky-comment-link", [text(segment.text)]);
				case "mention":
					return externalLink(self.profileUrl(feature.did), "bsky-comment-mention", [text(segment.text)]);
				default:
					return externalLink(self.appBase + "/hashtag/" + encodeURIComponent(feature.tag), "bsky-comment-tag", [text(segment.text)]);
			}
		});
	};

	// Images and link cards are shown inline; anything else (quotes, videos)
	// gets a link to see it on Bluesky
	BlueskyCommentsWidget.prototype.buildEmbed = function (post) {
		var embed = post.embed;
		if (!embed) return null;
		var media = embed.$type === "app.bsky.embed.recordWithMedia#view" ? embed.media : embed;
		var parts = [];
		var images = media && media.$type === "app.bsky.embed.images#view" ? (media.images || []).filter(function (image) {
			return image && thread.isWebUrl(image.thumb) && thread.isWebUrl(image.fullsize);
		}) : [];
		if (images.length) {
			parts.push(element("div", "bsky-comment-images", images.map(function (image) {
				return externalLink(image.fullsize, "bsky-comment-image-link", [
					element("img", "bsky-comment-image", [], { src: image.thumb, alt: image.alt || "", loading: "lazy" })
				], image.alt);
			})));
		} else if (media && media.$type === "app.bsky.embed.external#view" && media.external && thread.isWebUrl(media.external.uri)) {
			parts.push(externalLink(media.external.uri, "bsky-comment-card", [
				element("span", "bsky-comment-card-title", [text(media.external.title || media.external.uri)])
			]));
		}
		if (media !== embed || !parts.length) {
			parts.push(externalLink(this.postUrl(post), "bsky-comment-attachment", [text(this.getText("SeeAttachment"))]));
		}
		return element("div", "bsky-comment-embed", parts);
	};

	/* Refresh */

	BlueskyCommentsWidget.prototype.refresh = function (changedTiddlers) {
		var changedAttributes = this.computeAttributes();
		var settingsChanged = Object.keys(changedTiddlers).some(function (title) {
			return title.indexOf(CONFIG_PREFIX) === 0 || title === LANGUAGE_TIDDLER;
		});
		var fieldChanged = this.attributes.post === undefined && changedTiddlers[this.tiddlerTitle] &&
			this.getPostField().trim() !== this.postLink;
		if (changedAttributes.tiddler || changedAttributes.post || settingsChanged || fieldChanged) {
			this.refreshSelf();
			return true;
		}
		return this.refreshChildren(changedTiddlers);
	};

	exports["bluesky-comments"] = BlueskyCommentsWidget;

})();
