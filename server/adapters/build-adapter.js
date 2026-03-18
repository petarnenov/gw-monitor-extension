/**
 * Abstract interface for build tool adapters.
 * Implementations: GradleAdapter (and future: MavenAdapter, NpmAdapter, etc.)
 */
class BuildAdapter {
    constructor(config, deployEnv) {
        this.config = config;
        this.deployEnv = deployEnv;
    }

    /** Run incremental build. Returns { success, output, incremental: true }. */
    async buildIncremental(logFn) { throw new Error('Not implemented'); }

    /** Run full clean + build. Returns { success, output, incremental: false }. */
    async buildFull(logFn) { throw new Error('Not implemented'); }

    /** Build only the main JAR. Returns { success, output }. */
    async buildJarOnly(logFn) { throw new Error('Not implemented'); }

    /** Verify build output exists. Throws on missing artifacts. */
    verifyBuildOutput(incremental) { throw new Error('Not implemented'); }

    /** Copy artifacts to deploy target. */
    async copyArtifacts(logFn, incremental) { throw new Error('Not implemented'); }

    /** Copy WebContent to app server webapps. */
    async copyToAppServer(logFn, incremental) { throw new Error('Not implemented'); }

    /** Verify deployed artifacts (checksums, etc.). */
    verifyArtifacts(logFn) { return; }

    /** Run post-deploy steps (BIRT extraction, billing agent injection, etc.). */
    async postDeploy(logFn) { return; }

    /** Get path to the main JAR file. */
    getJarPath() { throw new Error('Not implemented'); }
}

module.exports = BuildAdapter;
