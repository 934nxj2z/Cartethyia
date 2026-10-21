-- The public slug a share page is reachable at, held in the clear.
--
-- `token_encrypted` is the bearer token under the deployment's encryption key,
-- so a link cannot be re-displayed after that key changes — which is exactly
-- what happens when a backup is restored onto a fresh deployment. A share page
-- then dies on arrival even though the backup carried its row.
--
-- The slug is the half of the link that is not a secret: it names the page in
-- the URL and is looked up by index. Holding it in the clear means a restore
-- keeps every share page reachable under the same address, independent of the
-- encryption key.
--
-- Nullable with no default: rows written before this column have no slug, and
-- inventing one would publish an address the page never had.
ALTER TABLE "share_links"
  ADD COLUMN "slug" text;

CREATE UNIQUE INDEX "share_links_slug_uidx"
  ON "share_links" ("slug")
  WHERE "slug" IS NOT NULL;
