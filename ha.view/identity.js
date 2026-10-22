/** HA.View identity; source credits are never project release/install metadata. */
const SOURCE = Object.freeze({
  name: "TouchKio",
  author: "leukipp",
  license: "MIT",
  url: "https://github.com/leukipp/touchkio",
});

// Repository verification is an explicit maintainer assertion, not URL validation.
// Set haView.projectRepository = { url: "https://github.com/OWNER/REPO", verified: true }
// only after verifying that the repository exists and belongs to HA.View.
const projectRepository = (metadata) => {
  const repository = metadata.haView?.projectRepository;
  if (repository?.verified !== true || typeof repository.url !== "string") return null;
  const match = /^https:\/\/github\.com\/([a-z\d](?:[a-z\d-]*[a-z\d])?)\/([a-z\d_.-]+)$/i.exec(repository.url);
  if (!match || [".", ".."].includes(match[2])) return null;
  const [, owner, name] = match;
  if (owner.toLowerCase() === "leukipp" && ["touchkio", "ha.view"].includes(name.toLowerCase())) return null;
  return { owner, name, url: `https://github.com/${owner}/${name}` };
};

const createIdentity = (metadata) => {
  const repository = projectRepository(metadata);
  return {
    title: "HA View",
    source: SOURCE,
    sourceOnly: true,
    repository,
    homepage: repository?.url ?? undefined,
    issues: repository ? `${repository.url}/issues` : null,
    releases: {
      url: repository ? `https://api.github.com/repos/${repository.owner}/${repository.name}/releases` : null,
      latest: null,
    },
    // OS packaging and install/update scripts are not available in this phase.
    scripts: { install: null },
  };
};

const applyIdentityPolicy = (identity, args) => {
  if (!identity.scripts.install && !args.app_disable.includes("mqtt_app")) args.app_disable.push("mqtt_app");
};

const assertPackagingAllowed = () => {
  throw new Error("HA View is source-only: packaging and publishing are disabled in this phase.");
};

module.exports = { createIdentity, applyIdentityPolicy, assertPackagingAllowed };
if (require.main === module) {
  try {
    assertPackagingAllowed();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
