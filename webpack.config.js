const path = require('path');
const webpack = require('webpack');
const fs = require('fs');
const CopyWebpackPlugin = require('copy-webpack-plugin')
const ZipPlugin = require('zip-webpack-plugin');
const GitRevisionPlugin = require('git-revision-webpack-plugin');
const shell = require("shelljs");
const GenerateJsonPlugin = require('generate-json-webpack-plugin');
const manifestGen = require('./browsers/ManifestGenerator');
const browserDefinitions = require('./browsers/BrowserDefinitions');
const UglifyJsPlugin = require('uglifyjs-webpack-plugin')
const JSZip = require("jszip");
const VersionNameGen = require("./browsers/VersionNameGen");

const gitDataCacheFile = "git_data.json";
const isInRepo = fs.existsSync("./.git/");

const genZipName = (version, target) => `r20es_${version}_${target}.zip`;

let git = {};
let gitPlugin = null;

if (isInRepo) {
    gitPlugin = new GitRevisionPlugin({
        branch: true,
        lightweightTags: true
    });

    git.version = gitPlugin.version();
    git.commit = gitPlugin.commithash();
    git.branch = gitPlugin.branch();
    // cache git data for source code zip
    fs.writeFileSync(gitDataCacheFile, JSON.stringify(git), "utf8");

} else {
    git = JSON.parse(fs.readFileSync(gitDataCacheFile, "utf8"));
}

const changelogFile = "changelog.json";

if(!fs.existsSync(changelogFile)) {
    console.log(`couldn't find ${changelogFile}`);
    process.exit(1);
}

const changelog = fs.readFileSync(changelogFile, "utf8");

module.exports = (_env, argv) => {
    let env = _env || {};

    const browsers = env.browsers && env.browsers.split(',');
    if (!browsers || browsers.length <= 0) {
        console.error("CLI arg --env.browsers with valid values expected but not found.");
        process.exit(1);
    }

    const isProd = argv.mode === "production";
    const wantsZip = "zip" in env && env.zip;

    const isPackaging = isInRepo && isProd && wantsZip;
    if (isPackaging) {
      /* const gitState = shell.exec("git diff-index --quiet HEAD -- && true");
        if(gitState.code !== 0) {
            console.error("Uncommited changes found in the working directory.");
            console.error("Packaging is not allowed.");
            console.error("Resolve the uncommited changes and try packaging in a clean working directory.");
            process.exit(1);
        }

        const changelogJson = JSON.parse(changelog);
        if(changelog.current === "TODO") {
            console.error("Current version in the changelog file is set to TODO.");
            console.error("Update the current version to the proper value before packaging.");
            process.exit(1);
        }

        if(!changelogJson.versions[changelogJson.current].info.title) {
            console.error(`Current version (${changelogJson.current}) has no title.`);
            console.error("Set a valid title before packaging");
            process.exit(1);
        }

        const gitLastTag = shell.exec("git describe --abbrev=0").stdout.trim();
        const numCommitsSinceLastTag = parseInt(shell.exec(`git rev-list "${gitLastTag}..HEAD" --count`).stdout.trim());

        if(numCommitsSinceLastTag > 0) {
            console.error("Cannot package when there are commits that do not fall under a tag.");
            console.error(`There are ${numCommitsSinceLastTag} commits since the last tag (${gitLastTag}).`);
            console.error(`Tag a new release before packaging.`);
            process.exit(1);
        }*/

        //prep source code
        const filename = `r20es_${git.version}_source.zip`;
        shell.exec(`git archive -o ${filename} HEAD ":(exclude)page"`);

        fs.readFile(filename, (err, data) => {
            if (err) throw err;
            JSZip.loadAsync(data).then(zip => {
                zip.file(gitDataCacheFile, fs.readFileSync(gitDataCacheFile, "utf8"));

                zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true })
                    .pipe(fs.createWriteStream(filename));
            });
        });

        //prep deploy data
        const deployData = {
            version: VersionNameGen(git.version)
        };

        for (const b of browsers) {
            const browser = browserDefinitions[b];
            deployData[browser.target] = genZipName(git.version, browser.target);
        }

        fs.writeFile("./deploy_data.json", JSON.stringify(deployData), "utf8", (err) => { if (err) console.error(err) });
    }

    console.log(browsers);

    return browsers.map((b) => {

        const entry = {};
        const staticFiles = {};

        const addStaticFile = (mappedName, sourcePath) => staticFiles[mappedName] = sourcePath;
        const addEntryPoint = (mappedName, sourcePath) => entry[mappedName] = sourcePath;
        const addStaticFolder = (root) => {
            fs.readdirSync(root).forEach(f => {
                const rootFile = root + f;
                if (fs.lstatSync(rootFile).isDirectory()) return;
                addStaticFile(f, rootFile);
            });
        };

        addStaticFolder("./css/");
        addStaticFolder("./assets/logo/");

        {
            const root = "./src/modules/";
            fs.readdirSync(root).forEach(dirname => {
                const rootDirname = root + dirname;
                if (!fs.lstatSync(rootDirname).isDirectory()) return;

                // look for the entry point
                const entryRegex = /Module(\.js.?$|\.ts.?$)/i;
                fs.readdirSync(rootDirname).forEach(f => {
                    if (!f.match(entryRegex)) return;

                    addEntryPoint(dirname + ".js", "./" + path.join(root, dirname, f));
                });
            });
        }

        {
            const root = "./src/entrypoints/"
            fs.readdirSync(root).forEach(f => {
                const rootFile = root + f;
                if (fs.lstatSync(rootFile).isDirectory()) return;

                addEntryPoint(f, rootFile);
            });
        }

        const browser = browserDefinitions[b];
        const sourceOutputPath = path.join(path.resolve(__dirname), "builds", browser.target, isProd ? "prod" : "dev");
        const packageOutputPath = path.join(path.resolve(__dirname), "dist", browser.target, isProd ? "prod" : "dev");

        if (browser.extraFiles) {
            for (const file of browser.extraFiles) {
                addStaticFile(path.basename(file), file);
            }
        }

        const finalManifest = manifestGen(browser, git.version);

        console.log(entry);
        console.log(staticFiles);

        let config = {
            performance: {
                hints: false
            },

            context: __dirname,
            node: { __filename: true, __dirname: true },
            target: "web",

            entry: entry,

            output: {
                path: sourceOutputPath,
                filename: '[name]',
            },

            module: {
                rules: [
                    {
                        test: /(\.js|\.jsx)$/,
                        exclude: /node_modules/,
                        use: [{
                            loader: 'babel-loader',
                            options: {
                                plugins: [
                                    ['transform-define', {
                                        'process.env.BUILD_TARGET': browser.target,
                                        'process.env.NODE_ENV': argv.mode,
                                    }],
                                ]
                            }
                        }],
                    },
                    {
                        test: /(\.ts|\.tsx)$/,
                        loaders: ['awesome-typescript-loader']
                    },
                ],
            },

            resolve: {
                extensions: ['.tsx', '.ts', '.js', '.jsx'],
                modules: [
                    'src',
                    'node_modules',
                ],
            },

            plugins: [
                new CopyWebpackPlugin(Object.keys(staticFiles).reduce((accum, mappedName) => {
                    accum.push({
                        from: staticFiles[mappedName],
                        to: path.join(sourceOutputPath, mappedName)
                    });
                    return accum;
                }, [])),

                new webpack.DefinePlugin({
                    "build.R20ES_VERSION": JSON.stringify(git.version),
                    "build.R20ES_COMMIT": JSON.stringify(git.commit),
                    "build.R20ES_BRANCH": JSON.stringify(git.branch),
                    "build.R20ES_BROWSER": JSON.stringify(browser.target),
                    "VTTES_BROWSER": JSON.stringify(browser.target),
                    "build.R20ES_CHANGELOG": JSON.stringify(changelog),
                    'build_R20ES_IS_DEV': JSON.stringify(isProd === false),
                    'process.env.NODE_ENV': JSON.stringify('production'),
                }),
                new GenerateJsonPlugin("manifest.json", finalManifest),
            ],

            devtool: "sourcemap"
        };

        if (isProd) {
            delete config.devtool;
            config.optimization = { minimizer: [new UglifyJsPlugin({ test: /\.js$|\.jsx$|\.ts$|\.tsx$/i, parallel: true })] };
        }

        if (wantsZip) {
            config.plugins.push(new ZipPlugin({
              path: packageOutputPath,
              filename: genZipName(git.version, browser.id),
              fileOptions: {
                mtime: new Date(0),
                mode: 0o100664,
                compress: true,
                forceZip64Format: false,
              },
            }))
        }

        return config;
    });
}
