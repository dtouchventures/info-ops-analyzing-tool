# Kenya news discovery and Latest news

Verification now includes a Kenya-focused news-index search using SerpApi Google News, alongside official KDF/MoD checks. Searches are open to indexed publishers rather than restricted to four websites or a closed list. Each claim uses one additional SerpApi query, subject to account quotas. Search results are suggestions; pages still need to be read and compared with the claim. Paywalls, inaccessible pages and missing coverage remain limitations. No bypass of publisher access controls is attempted.

The seed publisher catalogue identifies national television, print, radio and digital outlets. Additional indexed outlets are retained as candidates with reliability unassessed, rather than automatically receiving an established-news rating. Domain suffix matching rejects lookalike domains. Known Nation Media, Standard Group and Radio Africa brands share corroboration origins; near-identical copied reporting is also deduplicated. Contradictions remain visible. A publisher's identity or registration is not proof that a particular story is true.

Identity/ownership references:
- https://www.nationmedia.com/brands/
- https://www.standardmedia.co.ke/corporate/about-us
- https://radioafricagroup.co.ke/brands/
- https://royalmedia.co.ke/citizen-digital/
- Media Council register (context for the broader media landscape, not a blanket trust list): https://mediacouncil.or.ke/sites/default/files/downloads/Media%20House%20Register%202025_0.pdf

AI Watchlist has a separate **Latest news** tab at `#/watch/news`. It reads the public Google News Kenya-related RSS search feed, with no SerpApi calls or API-key exposure. Headlines from additional regional and digital publishers may appear; the feed can also contain international coverage of Kenya. It does not claim to include every Kenyan outlet, offline broadcast, subscription-only article or newly published story.

The visible page checks every 60 seconds. The server caches responses for 60 seconds, combines simultaneous requests, and retains prior headlines with an explicit stale warning if refresh fails. Publication times are displayed in the app's East Africa time format. Publication-to-index delays mean the feed cannot guarantee instant appearance. Headlines are not verified findings and are not inserted into keyword posts, watchlist matches or alerts. Users can still use the existing Watchlists and Alerts tabs independently.

Checks: real public Kenya news query and RSS fetch; nested news results, open publisher discovery, source-group deduplication, safe links, cache/single-flight/error handling, authenticated feed access and no keyword-record insertion; browser navigation, refresh, escaped headlines and mobile layout.

## Security news
A separate **Security news** tab at `#/watch/security` uses the same public news-index service, publisher range, safe-link handling and one-minute refresh as Latest news. It applies a fixed Kenya security/defence/policing/terrorism/banditry/border topic query, with an independent cache. It does not modify saved watchlist terms, keyword matches or alerts. The displayed headlines are discovery leads and can be delayed or imperfectly classified by the upstream index; they are not verified security assessments.
