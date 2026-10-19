---
title: "Search"
draft: false
comments: false
hideMeta: true
---


{{< trusted-html >}}
<link href="/search/pagefind-ui.css" rel="stylesheet">
<script src="/search/pagefind-ui.js"></script>
<div id="search"></div>
<script>
    window.addEventListener('DOMContentLoaded', (event) => {
        new PagefindUI({ element: "#search", showSubResults: true });
    });
</script>
{{< /trusted-html >}}
