import * as babel from '@babel/core';
import {
	transformSync,
	loadPartialConfig,
	transformAsync,
	buildExternalHelpers,
	DEFAULT_EXTENSIONS,
} from '@babel/core';
import { createFilter } from 'rollup-pluginutils';
import { addNamed } from '@babel/helper-module-imports';

var INLINE = {};
var RUNTIME = {};
var EXTERNAL = {};

// NOTE: DO NOT REMOVE the null character `\0` as it may be used by other plugins
// e.g. https://github.com/rollup/rollup-plugin-node-resolve/blob/313a3e32f432f9eb18cc4c231cc7aac6df317a51/src/index.js#L74
var HELPERS = '\0rollupPluginBabelHelpers.js';

function importHelperPlugin() {
	return {
		pre: function pre(file) {
			var cachedHelpers = {};
			file.set('helperGenerator', function(name) {
				if (!file.availableHelper(name)) {
					return;
				}

				if (cachedHelpers[name]) {
					return cachedHelpers[name];
				}

				return (cachedHelpers[name] = addNamed(file.path, name, HELPERS));
			});
		},
	};
}

var addBabelPlugin = function(options, plugin) {
	return Object.assign({}, options, { plugins: options.plugins.concat(plugin) });
};

var warned = {};
function warnOnce(ctx, msg) {
	if (warned[msg]) {
		return;
	}
	warned[msg] = true;
	ctx.warn(msg);
}

var regExpCharactersRegExp = /[\\^$.*+?()[\]{}|]/g;
var escapeRegExpCharacters = function(str) {
	return str.replace(regExpCharactersRegExp, '\\$&');
};

var MODULE_ERROR =
	'Rollup requires that your Babel configuration keeps ES6 module syntax intact. ' +
	'Unfortunately it looks like your configuration specifies a module transformer ' +
	'to replace ES6 modules with another module format. To continue you have to disable it.' +
	'\n\n' +
	"Most commonly it's a CommonJS transform added by @babel/preset-env - " +
	'in such case you should disable it by adding `modules: false` option to that preset ' +
	'(described in more detail here - https://github.com/rollup/rollup-plugin-babel#modules ).';

var UNEXPECTED_ERROR =
	'An unexpected situation arose. Please raise an issue at ' +
	'https://github.com/rollup/rollup-plugin-babel/issues. Thanks!';

function fallbackClassTransform() {
	return {
		visitor: {
			ClassDeclaration: function ClassDeclaration(path, state) {
				path.replaceWith(state.file.addHelper('inherits'));
			},
		},
	};
}

function createPreflightCheck() {
	var preflightCheckResults = {};

	return function(ctx, options) {
		var key = options.filename;

		if (preflightCheckResults[key] === undefined) {
			var helpers;

			var inputCode = 'class Foo extends Bar {};\nexport default Foo;';
			var transformed = transformSync(inputCode, options);

			var check = transformed.code;

			if (~check.indexOf('class ')) {
				check = transformSync(inputCode, addBabelPlugin(options, fallbackClassTransform)).code;
			}

			if (
				!~check.indexOf('export default') &&
				!~check.indexOf('export default Foo') &&
				!~check.indexOf('export { Foo as default }')
			) {
				ctx.error(MODULE_ERROR);
			}

			if (check.match(/\/helpers\/(esm\/)?inherits/)) {
				helpers = RUNTIME;
			} else if (~check.indexOf('function _inherits')) {
				helpers = INLINE;
			} else if (~check.indexOf('babelHelpers')) {
				helpers = EXTERNAL;
			} else {
				ctx.error(UNEXPECTED_ERROR);
			}

			preflightCheckResults[key] = helpers;
		}

		return preflightCheckResults[key];
	};
}

async function transformCode(inputCode, babelOptions, overrides, customOptions, ctx, finalizeOptions) {
	var config = loadPartialConfig(babelOptions);

	if (!config) {
		return null;
	}

	var transformOptions = !overrides.config
		? config.options
		: await overrides.config.call(this, config, {
				code: code,
				customOptions: customOptions,
		  });

	if (finalizeOptions) {
		transformOptions = await finalizeOptions(transformOptions);
	}

	if (!overrides.result) {
		var ref = await transformAsync(inputCode, transformOptions);
		var code$1 = ref.code;
		var map$1 = ref.map;
		return { code: code$1, map: map$1 };
	}

	var result = await transformAsync(inputCode, transformOptions);
	var ref$1 = await overrides.result.call(ctx, result, {
		code: inputCode,
		customOptions: customOptions,
		config: config,
		transformOptions: transformOptions,
	});
	var code = ref$1.code;
	var map = ref$1.map;
	return { code: code, map: map };
}

function objectWithoutProperties(obj, exclude) {
	var target = {};
	for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k) && exclude.indexOf(k) === -1) target[k] = obj[k];
	return target;
}

var unpackOptions = function(ref) {
	if (ref === void 0) ref = {};
	var extensions = ref.extensions;
	if (extensions === void 0) extensions = DEFAULT_EXTENSIONS;
	var sourcemap = ref.sourcemap;
	if (sourcemap === void 0) sourcemap = true;
	var sourcemaps = ref.sourcemaps;
	if (sourcemaps === void 0) sourcemaps = true;
	var sourceMap = ref.sourceMap;
	if (sourceMap === void 0) sourceMap = true;
	var sourceMaps = ref.sourceMaps;
	if (sourceMaps === void 0) sourceMaps = true;
	var rest$1 = objectWithoutProperties(ref, ['extensions', 'sourcemap', 'sourcemaps', 'sourceMap', 'sourceMaps']);
	var rest = rest$1;

	return Object.assign(
		{},
		{ extensions: extensions, plugins: [], sourceMaps: sourcemap && sourcemaps && sourceMap && sourceMaps },
		rest,
		{ caller: Object.assign({}, { name: 'rollup-plugin-babel' }, rest.caller) },
	);
};

var unpackInputPluginOptions = function(options) {
	return unpackOptions(
		Object.assign({}, options, {
			caller: Object.assign(
				{},
				{ supportsStaticESM: true, supportsDynamicImport: true, supportsTopLevelAwait: true },
				options.caller,
			),
		}),
	);
};

var unpackOutputPluginOptions = function(options, ref) {
	var format = ref.format;

	return unpackOptions(
		Object.assign({}, { configFile: false, sourceType: format === 'es' ? 'module' : 'script' }, options, {
			caller: Object.assign({}, { supportsStaticESM: format === 'es' }, options.caller),
		}),
	);
};

function getOptionsWithOverrides(pluginOptions, overrides) {
	if (pluginOptions === void 0) pluginOptions = {};
	if (overrides === void 0) overrides = {};

	if (!overrides.options) {
		return { customOptions: null, pluginOptionsWithOverrides: pluginOptions };
	}
	var overridden = overrides.options(pluginOptions);

	if (typeof overridden.then === 'function') {
		throw new Error(
			".options hook can't be asynchronous. It should return `{ customOptions, pluginsOptions }` synchronously.",
		);
	}

	return {
		customOptions: overridden.customOptions || null,
		pluginOptionsWithOverrides: overridden.pluginOptions || pluginOptions,
	};
}

var returnObject = function() {
	return {};
};

function createBabelInputPluginFactory(customCallback) {
	if (customCallback === void 0) customCallback = returnObject;

	var overrides = customCallback(babel);

	return function(pluginOptions) {
		var ref = getOptionsWithOverrides(pluginOptions, overrides);
		var customOptions = ref.customOptions;
		var pluginOptionsWithOverrides = ref.pluginOptionsWithOverrides;

		var ref$1 = unpackInputPluginOptions(pluginOptionsWithOverrides);
		var exclude = ref$1.exclude;
		var extensions = ref$1.extensions;
		var externalHelpers = ref$1.externalHelpers;
		var externalHelpersWhitelist = ref$1.externalHelpersWhitelist;
		var include = ref$1.include;
		var runtimeHelpers = ref$1.runtimeHelpers;
		var rest = objectWithoutProperties(ref$1, [
			'exclude',
			'extensions',
			'externalHelpers',
			'externalHelpersWhitelist',
			'include',
			'runtimeHelpers',
		]);
		var babelOptions = rest;

		var preflightCheck = createPreflightCheck();
		var extensionRegExp = new RegExp('(' + extensions.map(escapeRegExpCharacters).join('|') + ')$');
		var includeExcludeFilter = createFilter(include, exclude);
		var filter = function(id) {
			return extensionRegExp.test(id) && includeExcludeFilter(id);
		};

		return {
			name: 'babel',

			resolveId: function resolveId(id) {
				if (id === HELPERS) {
					return id;
				}
			},

			load: function load(id) {
				if (id === HELPERS) {
					return buildExternalHelpers(externalHelpersWhitelist, 'module');
				}
			},

			transform: function transform(code, filename) {
				var this$1 = this;

				if (!filter(filename)) {
					return null;
				}
				if (filename === HELPERS) {
					return null;
				}

				return transformCode(
					code,
					Object.assign({}, babelOptions, { filename: filename }),
					overrides,
					customOptions,
					this,
					function(transformOptions) {
						var helpers = preflightCheck(this$1, transformOptions);

						if (helpers === EXTERNAL && !externalHelpers) {
							warnOnce(
								this$1,
								'Using "external-helpers" plugin with rollup-plugin-babel is deprecated, as it now automatically deduplicates your Babel helpers.',
							);
						} else if (helpers === RUNTIME && !runtimeHelpers) {
							this$1.error(
								'Runtime helpers are not enabled. Either exclude the transform-runtime Babel plugin or pass the `runtimeHelpers: true` option. See https://github.com/rollup/rollup-plugin-babel#configuring-babel for more information',
							);
						}

						if (helpers !== RUNTIME && !externalHelpers) {
							return addBabelPlugin(transformOptions, importHelperPlugin);
						}

						return transformOptions;
					},
				);
			},
		};
	};
}

function getRecommendedFormat(rollupFormat) {
	switch (rollupFormat) {
		case 'amd':
			return 'amd';
		case 'iife':
		case 'umd':
			return 'umd';
		case 'system':
			return 'systemjs';
		default:
			return '<module format>';
	}
}

function createBabelOutputPluginFactory(customCallback) {
	if (customCallback === void 0) customCallback = returnObject;

	var overrides = customCallback(babel);

	return function(pluginOptions) {
		var ref = getOptionsWithOverrides(pluginOptions, overrides);
		var customOptions = ref.customOptions;
		var pluginOptionsWithOverrides = ref.pluginOptionsWithOverrides;

		return {
			name: 'babel',

			renderStart: function renderStart(outputOptions) {
				var extensions = pluginOptionsWithOverrides.extensions;
				var include = pluginOptionsWithOverrides.include;
				var exclude = pluginOptionsWithOverrides.exclude;
				var allowAllFormats = pluginOptionsWithOverrides.allowAllFormats;

				if (extensions || include || exclude) {
					warnOnce(this, 'The "include", "exclude" and "extensions" options are ignored when transforming the output.');
				}
				if (!allowAllFormats && outputOptions.format !== 'es' && outputOptions.format !== 'cjs') {
					this.error(
						'Using Babel on the generated chunks is strongly discouraged for formats other than "esm" or "cjs" as it can easily break wrapper code and lead to accidentally created global variables. Instead, you should set "output.format" to "esm" and use Babel to transform to another format, e.g. by adding "presets: [[\'@babel/env\', { modules: \'' +
							getRecommendedFormat(outputOptions.format) +
							'\' }]]" to your Babel options. If you still want to proceed, add "allowAllFormats: true" to your plugin options.',
					);
				}
			},

			renderChunk: function renderChunk(code, chunk, outputOptions) {
				/* eslint-disable no-unused-vars */
				var ref = unpackOutputPluginOptions(pluginOptionsWithOverrides, outputOptions);
				var allowAllFormats = ref.allowAllFormats;
				var exclude = ref.exclude;
				var extensions = ref.extensions;
				var externalHelpers = ref.externalHelpers;
				var externalHelpersWhitelist = ref.externalHelpersWhitelist;
				var include = ref.include;
				var runtimeHelpers = ref.runtimeHelpers;
				var rest = objectWithoutProperties(ref, [
					'allowAllFormats',
					'exclude',
					'extensions',
					'externalHelpers',
					'externalHelpersWhitelist',
					'include',
					'runtimeHelpers',
				]);
				var babelOptions = rest;
				/* eslint-enable no-unused-vars */

				return transformCode(code, babelOptions, overrides, customOptions, this);
			},
		};
	};
}

var babelPluginFactory = createBabelInputPluginFactory();
babelPluginFactory.custom = createBabelInputPluginFactory;
babelPluginFactory.generated = createBabelOutputPluginFactory();
babelPluginFactory.generated.custom = createBabelOutputPluginFactory;

export default babelPluginFactory;
//# sourceMappingURL=rollup-plugin-babel.esm.js.map
