const fs = require('fs');
const { exec } = require('child_process');
const BuildAdapter = require('./build-adapter');
const { runCmd, lastLines } = require('../utils');

class GradleAdapter extends BuildAdapter {
    constructor(config, deployEnv) {
        super(config, deployEnv);
        this.sourceDir = config.paths.source;
        this.deployTarget = config.paths.deploy_target;
        this.appServerHome = config.app_server.home;
        this.cmds = config.build.commands;
        this.output = config.build.output;
    }

    async buildIncremental(logFn) {
        const cmd = this.cmds.incremental || './gradlew devClasses devLib jar';
        try {
            const out = await this._exec(`cd "${this.sourceDir}" && ${cmd} 2>&1`, 300000);
            logFn(lastLines(out, 5));
            return { success: true, output: out, incremental: true };
        } catch (e) {
            return { success: false, output: e.message, incremental: true };
        }
    }

    async buildFull(logFn) {
        const cleanCmd = this.cmds.full_clean || './gradlew clean';
        try {
            const cleanOut = await this._exec(`cd "${this.sourceDir}" && ${cleanCmd} 2>&1`, 120000);
            logFn(lastLines(cleanOut, 3));
        } catch (e) {
            throw new Error(`Gradle clean failed:\n${lastLines(e.message, 15)}`);
        }

        const buildCmd = this.cmds.full_build || './gradlew makebuild -Pbuild_react=false -Pbuild_sencha=false';
        try {
            const buildOut = await this._exec(`cd "${this.sourceDir}" && ${buildCmd} 2>&1`, 600000);
            logFn(lastLines(buildOut, 5));
            return { success: true, output: buildOut, incremental: false };
        } catch (e) {
            const compileError = e.message.match(/error:.*$/gm);
            let detail = lastLines(e.message, 30);
            if (compileError) {
                detail = 'Compilation errors:\n' + compileError.join('\n') + '\n\n' + lastLines(e.message, 10);
            }
            throw new Error(`Gradle build failed:\n${detail}`);
        }
    }

    async buildJarOnly(logFn) {
        const jarCmd = this.cmds.jar_only || './gradlew jar';
        const out = await this._exec(`cd "${this.sourceDir}" && ${jarCmd} 2>&1`, 120000);
        logFn(lastLines(out, 5));
        return { success: true, output: out };
    }

    verifyBuildOutput(incremental) {
        const devDir = this.output.dev_dir || 'devBuild';
        const releaseDir = this.output.release_dir || 'build/release';
        const jarDir = this.output.jar_dir || 'build/libs';
        const jarName = this.output.jar_name || 'geowealth.jar';

        if (incremental) {
            if (!fs.existsSync(`${this.sourceDir}/${devDir}/lib`)) {
                throw new Error(`Incremental build output missing: ${devDir}/lib not found.`);
            }
            if (!fs.existsSync(`${this.sourceDir}/${jarDir}/${jarName}`)) {
                throw new Error(`Incremental build output missing: ${jarDir}/${jarName} not found.`);
            }
            const jarCount = runCmd(`ls "${this.sourceDir}/${devDir}/lib/"*.jar 2>/dev/null | wc -l`);
            return `Incremental build: ${jarCount} dependency JAR(s) + ${jarName}`;
        } else {
            const buildDir = `${this.sourceDir}/${releaseDir}`;
            if (!fs.existsSync(`${buildDir}/lib`)) {
                throw new Error(`Build output missing: ${buildDir}/lib not found.\nGradle may have succeeded but produced no artifacts. Check build.gradle.`);
            }
            const jarCount = runCmd(`ls "${buildDir}/lib/"*.jar 2>/dev/null | wc -l`);
            return `Full build produced ${jarCount} JAR(s)`;
        }
    }

    async copyArtifacts(logFn, incremental) {
        const BE_HOME = this.deployTarget;
        const devDir = this.output.dev_dir || 'devBuild';
        const releaseDir = this.output.release_dir || 'build/release';
        const jarDir = this.output.jar_dir || 'build/libs';
        const jarName = this.output.jar_name || 'geowealth.jar';
        const agentConfigFile = this.config.agents ? this.config.agents.config_file : '';

        const libCopyCmd = incremental
            ? `mkdir -p "${BE_HOME}/lib" && cp -r ./${devDir}/lib/* "${BE_HOME}/lib/" && cp ./${jarDir}/${jarName} "${BE_HOME}/lib/"`
            : `cp -r ./${releaseDir}/lib "${BE_HOME}"`;

        try {
            await this._exec(`
                cd "${this.sourceDir}" &&
                rm -rf "${BE_HOME}/lib" "${BE_HOME}/bin" "${BE_HOME}/sbin" "${BE_HOME}/etc" "${BE_HOME}/dev_etc" \
                       "${BE_HOME}/birt_reports" "${BE_HOME}/profilers" "${BE_HOME}/templates" "${BE_HOME}/exports" \
                       "${BE_HOME}/WebContent" "${BE_HOME}/birt_platform" &&
                mkdir -p "${BE_HOME}/pids" "${BE_HOME}/logs" &&
                ${libCopyCmd} &&
                cp -r ./bin "${BE_HOME}" &&
                cp -r ./sbin "${BE_HOME}" &&
                cp -r ./birt_platform.tar.gz "${BE_HOME}" &&
                cp -r ./birt_reports "${BE_HOME}" &&
                cp -r ./dev_etc "${BE_HOME}" &&
                cp -r ./etc "${BE_HOME}" &&
                cp -r ./profilers "${BE_HOME}" &&
                cp -r ./templates "${BE_HOME}" &&
                cp -r ./exports "${BE_HOME}" &&
                cp -r ./WebContent "${BE_HOME}" &&
                cp "${agentConfigFile}" "${BE_HOME}/etc/" &&
                cp ./etc/*.properties "${BE_HOME}/etc/" &&
                cp ./src/main/resources/*.properties "${BE_HOME}/etc/" &&
                cp ./etc/hibernate-dbhost.properties "${BE_HOME}/etc/hibernate.properties" &&
                cp ./src/main/resources/*.xml "${BE_HOME}/etc/"
            `, 120000);
        } catch (e) {
            throw new Error(`Artifact copy failed:\n${e.message}\n\nCheck disk space: df -h /\nCheck permissions on ${BE_HOME}`);
        }
        logFn(`Artifacts copied to BEServer (${incremental ? 'incremental' : 'full'} build)`);
    }

    async copyToAppServer(logFn, incremental) {
        const devDir = this.output.dev_dir || 'devBuild';
        const releaseDir = this.output.release_dir || 'build/release';
        const jarDir = this.output.jar_dir || 'build/libs';
        const jarName = this.output.jar_name || 'geowealth.jar';
        const tomcatWebapps = `${this.appServerHome}/webapps/ROOT`;

        try {
            if (incremental) {
                await this._exec(`
                    rm -rf "${tomcatWebapps}/"* &&
                    cp -r "${this.sourceDir}/WebContent/"* "${tomcatWebapps}/" &&
                    mkdir -p "${tomcatWebapps}/WEB-INF/lib" &&
                    cp -r "${this.sourceDir}/${devDir}/lib/"* "${tomcatWebapps}/WEB-INF/lib/" &&
                    cp "${this.sourceDir}/${jarDir}/${jarName}" "${tomcatWebapps}/WEB-INF/lib/"
                `, 30000);
                logFn(`WebContent deployed to Tomcat (incremental: source + ${devDir} JARs)`);
            } else {
                await this._exec(`rm -rf "${tomcatWebapps}/"* && cp -r "${this.sourceDir}/${releaseDir}/WebContent/"* "${tomcatWebapps}/"`, 30000);
                logFn('WebContent deployed to Tomcat (full build)');
            }
        } catch (e) {
            throw new Error(`Failed to copy WebContent to Tomcat:\n${e.message}\n\nCheck if ${tomcatWebapps} is writable.`);
        }
    }

    verifyArtifacts(logFn) {
        const BE_HOME = this.deployTarget;
        const tomcatLib = `${this.appServerHome}/webapps/ROOT/WEB-INF/lib`;
        const beLib = `${BE_HOME}/lib`;

        let fixed = 0;
        try {
            const jars = fs.readdirSync(tomcatLib).filter(f => f.endsWith('.jar'));
            for (const jar of jars) {
                const tomcatPath = `${tomcatLib}/${jar}`;
                const bePath = `${beLib}/${jar}`;
                if (fs.existsSync(bePath)) {
                    const tomcatMd5 = runCmd(`md5sum "${tomcatPath}" | awk '{print $1}'`);
                    const beMd5 = runCmd(`md5sum "${bePath}" | awk '{print $1}'`);
                    if (tomcatMd5 && beMd5 && tomcatMd5 !== beMd5) {
                        fs.copyFileSync(bePath, tomcatPath);
                        logFn(`Fixed corrupted JAR: ${jar}`);
                        fixed++;
                    }
                }
            }
        } catch (e) {
            logFn(`WARNING: JAR verification error: ${e.message}`);
        }
        if (fixed > 0) {
            logFn(`${fixed} corrupted JAR(s) replaced from BEServer/lib`);
        } else {
            logFn('All JARs verified OK');
        }
    }

    async postDeploy(logFn) {
        const BE_HOME = this.deployTarget;

        // Inject billing agents if needed
        const jrunFile = `${BE_HOME}/etc/jrunagents.xml`;
        if (!runCmd(`grep -l BillingManager "${jrunFile}" 2>/dev/null`)) {
            logFn('Injecting billing agents into jrunagents.xml...');
            try {
                await this._exec(`sed -i '/<\\/AGENTLIST>/i \\
   <AGENT alias="BillingManager">\\
      <TRAITLIST>\\
         <TRAIT class="com.geowealth.agent.billing.BillingManagerTrait" />\\
      </TRAITLIST>\\
   </AGENT>\\
\\
   <AGENT alias="BillingProcessManager">\\
      <TRAITLIST>\\
         <TRAIT class="com.geowealth.agent.billing.BillingProcessManagerTrait" />\\
      </TRAITLIST>\\
   </AGENT>\\
\\
   <AGENT alias="BillingSpecificationManager">\\
      <TRAITLIST>\\
         <TRAIT class="com.geowealth.agent.billingspecification.BillingSpecificationManagerTrait" />\\
      </TRAITLIST>\\
   </AGENT>' "${jrunFile}"`, 10000);
                logFn('Billing agents injected');
            } catch (e) {
                logFn(`WARNING: Could not inject billing agents: ${e.message}`);
            }
        } else {
            logFn('Billing agents already present in jrunagents.xml');
        }

        // Extract BIRT platform
        try {
            await this._exec(`cd "${BE_HOME}" && tar -xzf birt_platform.tar.gz`, 30000);
            logFn('BIRT platform extracted');
        } catch (e) {
            logFn(`WARNING: BIRT platform extraction failed: ${e.message}`);
        }
    }

    getJarPath() {
        const jarDir = this.output.jar_dir || 'build/libs';
        const jarName = this.output.jar_name || 'geowealth.jar';
        return `${this.sourceDir}/${jarDir}/${jarName}`;
    }

    _exec(cmd, timeout = 120000) {
        return new Promise((resolve, reject) => {
            exec(cmd, { timeout, encoding: 'utf8', env: this.deployEnv, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) reject(new Error(stderr || stdout || err.message));
                else resolve((stdout || '').trim());
            });
        });
    }
}

module.exports = GradleAdapter;
