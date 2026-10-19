/**
 * Public source and distribution links, in one place.
 *
 * `risunCode/Cartethyia` is the primary repository. GitHub hid it from public
 * view after automated star activity was flagged as manipulation, so
 * `risunCodex/Cartethyia` is published as a mirror with the same history — the
 * split button surfaces both so a reader who cannot reach the primary still
 * has somewhere to go.
 *
 * These were declared twice: one copy in the console shell built them from a
 * repo slug, and the share page's badge component carried its own hardcoded URL
 * plus a second copy of the slug for the shields.io badges. Two literals for
 * one repository means a rename moves one surface and leaves the other pointing
 * at the old project, so every link and every badge resolves from here.
 */

/** The primary repository. Currently hidden from public view by GitHub. */
export const GITHUB_REPO = "risunCode/Cartethyia";
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO}`;
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

/**
 * The published alternative. Same history, different account, reachable.
 *
 * Star and fork counts are read from this one: the primary's badges would
 * render zero or fail to load while the repository is hidden, and a badge that
 * reports a number the reader cannot act on is worse than no badge.
 */
export const GITHUB_ALT_REPO = "risunCodex/Cartethyia";
export const GITHUB_ALT_REPO_URL = `https://github.com/${GITHUB_ALT_REPO}`;
export const GITHUB_ALT_RELEASES_URL = `https://github.com/${GITHUB_ALT_REPO}/releases`;

export const GITLAB_REPO_URL = "https://gitlab.com/risuncode/cartethyia";
export const DISCORD_INVITE_URL = "https://discord.gg/zFcNPJM6qM";
export const NPM_PACKAGE = "cartethyia";
export const NPM_PACKAGE_URL = `https://www.npmjs.com/package/${NPM_PACKAGE}`;

/** One place a reader can obtain the project. */
export interface SourceLink {
  readonly id: "github-alt" | "github" | "gitlab" | "npm" | "discord";
  readonly label: string;
  readonly href: string;
  /** Shown under the label in the menu; says what the destination is. */
  readonly hint: string;
}

/**
 * The split button's menu, primary destination first.
 *
 * The alternative leads because the primary is hidden: leading with a
 * link that may not load defeats the purpose of offering a choice.
 */
export const SOURCE_LINKS: readonly SourceLink[] = [
  {
    id: "github-alt",
    label: "GitHub (alt)",
    href: GITHUB_ALT_REPO_URL,
    hint: "Mirror — star, fork, and releases",
  },
  {
    id: "github",
    label: "GitHub",
    href: GITHUB_REPO_URL,
    hint: "Primary repository",
  },
  {
    id: "gitlab",
    label: "GitLab",
    href: GITLAB_REPO_URL,
    hint: "Source mirror",
  },
  {
    id: "npm",
    label: "npm",
    href: NPM_PACKAGE_URL,
    hint: `Package — ${NPM_PACKAGE}`,
  },
  {
    id: "discord",
    label: "Discord",
    href: DISCORD_INVITE_URL,
    hint: "Community — questions, setups, and bug reports",
  },
];
