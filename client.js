/*jshint node:true */
/*global __internCoverage */
if (typeof process !== 'undefined' && typeof define === 'undefined') {
	(function () {
		var loader = (function () {
			for (var i = 2, mid; i < process.argv.length; ++i) {
				if ((mid = /^-{0,2}loader=(.*)/.exec(process.argv[i]))) {
					return mid[1];
				}
			}

			return 'dojo/dojo';
		})();

		var config = {
			baseUrl: process.cwd(),
			packages: [
				{ name: 'intern', location: __dirname }
			],
			map: {
				intern: {
					dojo: 'intern/node_modules/dojo',
					chai: 'intern/node_modules/chai/chai'
				},
				'*': {
					'intern/dojo': 'intern/node_modules/dojo'
				}
			}
		};

		if (loader === 'dojo/dojo') {
			config.async = 1;
			config.deps = [ 'intern/client' ];
			config.tlmSiblingOfDojo = 0;
			config.useDeferredInstrumentation = false;
			global.dojoConfig = config;
		}

		// this.require must be exposed explicitly in order to allow the loader to be
		// reconfigured from the configuration file
		var req = this.require = require(loader);

		if (loader !== 'dojo/dojo') {
			req.config(config);
			req([ 'intern/client' ]);
		}
	})();
}
else {
	define([
		'./main',
		'./lib/args',
		'./lib/reporterManager',
		'./lib/Suite',
		'./lib/util',
		'dojo/topic',
		'dojo/has',
		'dojo/_base/array',
		'require',
		'dojo/has!host-node?dojo/node!istanbul/lib/hook',
		'dojo/has!host-node?dojo/node!istanbul/lib/instrumenter'
	], function (main, args, reporterManager, Suite, util, topic, has, array, require, hook, Instrumenter) {
		if (!args.config) {
			throw new Error('Missing "config" argument');
		}

		require([ args.config ], function (config) {
			if (!config.loader) {
				config.loader = {};
			}

			// if a `baseUrl` is specified in the arguments for the page, it should have priority over what came from
			// the configuration file. this is especially important for the runner proxy, which serves `baseUrl`
			// as the root path and so `baseUrl` must become `/` in the client even if it was something else in the
			// config originally
			if (args.baseUrl) {
				config.loader.baseUrl = args.baseUrl;
			}

			(this.require ? this.require.config || this.require : require)(config.loader);

			if (!args.suites) {
				args.suites = config.suites;
			}

			// args.suites might be an array or it might be a scalar value but we always need deps to be a fresh array
			var deps = [].concat(args.suites);

			if (!args.reporters) {
				if (config.reporters) {
					args.reporters = config.reporters;
				}
				else {
					console.info('Defaulting to "console" reporter');
					args.reporters = 'console';
				}
			}

			// TODO: This is probably a fatal condition and so we need to let the runner know that no more information
			// will be forthcoming from this client
			if (has('host-browser')) {
				window.onerror = function (message, url, lineNumber, columnNumber, error) {
					error = error || new Error(message + ' at ' + url + ':' + lineNumber +
						(columnNumber !== undefined ? ':' + columnNumber : ''));

					if (!reportersReady) {
						console.error(error);
					}

					topic.publish('/error', error);
					topic.publish('/client/end', args.sessionId);
				};
			}
			else if (has('host-node')) {
				process.on('uncaughtException', function (error) {
					if (!reportersReady) {
						console.error(error.stack);
					}

					topic.publish('/error', error);
					process.exit(1);
				});
			}

			args.reporters = array.map([].concat(args.reporters), function (reporterModuleId) {
				// Allow 3rd party reporters to be used simply by specifying a full mid, or built-in reporters by
				// specifying the reporter name only
				if (reporterModuleId.indexOf('/') === -1) {
					reporterModuleId = './lib/reporters/' + reporterModuleId;
				}
				return reporterModuleId;
			});

			deps = deps.concat(args.reporters);

			// Client interface has only one environment, the current environment, and cannot run functional tests on
			// itself
			main.suites.push(new Suite({ name: 'main', sessionId: args.sessionId }));

			if (has('host-node')) {
				// Hook up the instrumenter before any code dependencies are loaded
				var basePath = (config.loader.baseUrl || process.cwd()).replace(/\/*$/, '/'),
					instrumentor = new Instrumenter({
						// coverage variable is changed primarily to avoid any jshint complaints, but also to make it
						// clearer where the global is coming from
						coverageVariable: '__internCoverage',

						// compacting code makes it harder to look at but it does not really matter
						noCompact: true,

						// auto-wrap breaks code
						noAutoWrap: true
					});

				hook.hookRunInThisContext(function (filename) {
					return !config.excludeInstrumentation ||
						// if the string passed to `excludeInstrumentation` changes here, it must also change in
						// `lib/createProxy.js`
						!config.excludeInstrumentation.test(filename.slice(basePath.length));
				}, function (code, filename) {
					return instrumentor.instrumentSync(code, filename);
				});
			}

			var reportersReady = false;
			require(deps, function () {
				// A hash map, { reporter module ID: reporter definition }
				var firstReporterIndex = arguments.length - args.reporters.length,
					reporters = util.reduce([].slice.call(arguments, firstReporterIndex), function (map, reporter, i) {
						map[args.reporters[i]] = reporter;
						return map;
					}, {});

				reporterManager.add(reporters);
				reportersReady = true;

				if (has('host-node')) {
					var hasErrors = false;

					topic.subscribe('/error, /test/fail', function () {
						hasErrors = true;
					});

					process.on('exit', function () {
						// calling `process.exit` after the main test loop finishes will cause any remaining
						// in-progress operations to abort, which is undesirable if there are any asynchronous
						// I/O operations that a reporter wants to perform once all tests are complete; calling
						// from within the exit event avoids this problem by allowing Node.js to decide when to
						// terminate
						process.exit(hasErrors ? 1 : 0);
					});
				}

				if (args.autoRun !== 'false') {
					main.run().then(function () {
						typeof __internCoverage !== 'undefined' &&
							topic.publish('/coverage', args.sessionId, __internCoverage);
					}).always(function () {
						reporterManager.clear();
					});
				}
			});
		});
	});
}
