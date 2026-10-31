// GitHub contract fixture shared by tests and the explicitly local-only preview.
// It never contacts GitHub and holds all commits in memory.
export function placeRepository(catalog = [], intercept) {
  let counter = 0;
  let head;
  const commits = new Map();
  const trees = new Map();
  const blobs = new Map();
  const calls = [];
  const next = prefix => `${prefix}-${++counter}`;
  function commitFiles(files) {
    const content = head ? new Map(trees.get(commits.get(head).tree)) : new Map();
    for (const [path, value] of Object.entries(files)) content.set(path, value);
    const tree = next("tree"); trees.set(tree, content);
    const sha = next("commit"); commits.set(sha, { tree, parents: head ? [head] : [] });
    head = sha;
    return sha;
  }
  commitFiles({ "data/places.json": JSON.stringify(catalog) });
  const repo = {
    calls, commitFiles,
    get head() { return head; },
    file(path) { return trees.get(commits.get(head).tree).get(path); },
    files() { return new Map(trees.get(commits.get(head).tree)); },
    catalog() { return JSON.parse(repo.file("data/places.json")); },
    setHead(sha) { head = sha; },
    async fetch(url, options = {}) {
      const endpoint = new URL(url);
      if (endpoint.origin !== "https://api.github.com") throw new Error("Unexpected origin");
      const path = endpoint.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
      const body = options.body ? JSON.parse(options.body) : undefined;
      const method = options.method || "GET";
      const call = { url, path, method, body, headers: options.headers };
      calls.push(call);
      const override = await intercept?.(call, repo);
      if (override) return override;
      if (path.startsWith("/contents/") && method === "GET") {
        const ref = endpoint.searchParams.get("ref");
        const sha = commits.has(ref) ? ref : head;
        const content = trees.get(commits.get(sha).tree).get(path.slice("/contents/".length));
        if (content === undefined) return new Response(null, { status: 404 });
        return Response.json({ sha: "file-sha", encoding: "base64", content: Buffer.from(content).toString("base64") });
      }
      if (path.startsWith("/git/ref/heads/") && method === "GET") return Response.json({ object: { sha: head } });
      if (path.startsWith("/git/commits/") && method === "GET") {
        const commit = commits.get(path.split("/").at(-1));
        return Response.json({ tree: { sha: commit.tree } });
      }
      if (path === "/git/blobs" && method === "POST") { const sha = next("blob"); blobs.set(sha, Buffer.from(body.content, body.encoding)); return Response.json({ sha }, { status: 201 }); }
      if (path === "/git/trees" && method === "POST") {
        const content = new Map(trees.get(body.base_tree));
        for (const item of body.tree) content.set(item.path, item.content ?? blobs.get(item.sha));
        const sha = next("tree"); trees.set(sha, content);
        return Response.json({ sha }, { status: 201 });
      }
      if (path === "/git/commits" && method === "POST") { const sha = next("commit"); commits.set(sha, { tree: body.tree, parents: body.parents }); return Response.json({ sha }, { status: 201 }); }
      if (path.startsWith("/git/refs/heads/") && method === "PATCH") {
        if (body.force !== false) throw new Error("Force push is forbidden");
        if (!commits.get(body.sha).parents.includes(head)) return new Response(null, { status: 409 });
        head = body.sha;
        return Response.json({ object: { sha: head } });
      }
      // The existing note-only publisher retains its Contents API behavior.
      if (path.startsWith("/contents/") && method === "PUT") {
        const file = path.slice("/contents/".length);
        commitFiles({ [file]: Buffer.from(body.content, "base64") });
        return Response.json({ commit: { sha: head }, content: { path: file } }, { status: 201 });
      }
      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    },
  };
  return repo;
}
