import * as fs from 'fs';
import assert from 'assert';
import * as path from 'path';

import { IApi, BundlerConfigType } from '@umijs/types';
import { winPath, Mustache, lodash } from '@umijs/utils';

import {
  CHUNK_NAME,
  OUTPUT_SERVER_FILENAME,
  TMP_PLUGIN_DIR,
  CLIENT_EXPORTS,
  DEFAULT_HTML_PLACEHOLDER,
} from './constants';
import { getDistContent } from './utils';

export default (api: IApi) => {
  api.describe({
    key: 'ssr',
    config: {
      schema: (joi) => {
        return joi.object({
          forceInitial: joi
            .boolean()
            .description(
              'remove window.g_initialProps and window.getInitialData in html, to force execing Page getInitialProps and App getInitialData functions',
            ),
          devServerRender: joi
            .boolean()
            .description('disable serve-side render in umi dev mode.'),
          stream: joi
            .boolean()
            .description('stream render, conflict with prerender'),
          staticMarkup: joi
            .boolean()
            .description('static markup in static site'),
        });
      },
    },
    // 配置开启
    enableBy: api.EnableBy.config,
  });

  api.onStart(() => {
    assert(
      api.config.history?.type !== 'hash',
      'the `type` of `history` must be `browser` when using SSR',
    );
  });

  // 再加一个 webpack instance
  api.modifyBundleConfigs(async (memo, { getConfig }) => {
    return [...memo, await getConfig({ type: BundlerConfigType.ssr })];
  });

  api.onGenerateFiles(async () => {
    const serverTpl = path.join(winPath(__dirname), 'templates/server.tpl');
    const serverContent = fs.readFileSync(serverTpl, 'utf-8');

    api.writeTmpFile({
      path: 'core/server.ts',
      content: Mustache.render(serverContent, {
        Renderer: winPath(
          path.dirname(require.resolve('@umijs/renderer-react/package')),
        ),
        Utils: winPath(require.resolve('./templates/utils')),
        Stream: !!api.config.ssr?.stream,
        MountElementId: api.config.mountElementId,
        StaticMarkup: !!api.config.ssr?.staticMarkup,
        // @ts-ignore
        ForceInitial: !!api.config.ssr?.forceInitial,
        Basename: api.config.base,
        DEFAULT_HTML_PLACEHOLDER,
      }),
    });

    const clientExportsContent = fs.readFileSync(
      path.join(winPath(__dirname), `templates/${CLIENT_EXPORTS}.tpl`),
      'utf-8',
    );
    api.writeTmpFile({
      path: `${TMP_PLUGIN_DIR}/${CLIENT_EXPORTS}.ts`,
      content: clientExportsContent,
    });
  });

  api.modifyHTMLChunks(async (memo, opts) => {
    // remove server bundle entry in html
    if (opts.type === BundlerConfigType.ssr) {
      return [];
    }
    // for dynamicImport
    if (api.config.dynamicImport) {
      // TODO: page bind opposite chunks, now will bind all chunks
      const chunks = opts.chunks.map((chunk) => {
        return chunk.name;
      });
      return lodash.uniq([...memo, ...chunks]);
    }
    return memo;
  });

  api.modifyConfig((config) => {
    if (!config.devServer) {
      config.devServer = {};
    }
    // DISCUSS: 是否需要强行改项目配置的方式，来开启 dev 下写 umi.server.js
    // force enable writeToDisk
    config.devServer.writeToDisk = (filePath: string) =>
      /(umi\.server\.js|index\.html|\.server\.js)$/.test(filePath);
    return config;
  });

  // modify devServer content
  api.modifyDevServerContent(async (defaultHtml, { req }) => {
    // skip hot update requests
    if (req.url.includes('hot-update.json')) {
      return defaultHtml;
    }
    // umi dev to enable server side render by default
    const { stream } = api.config?.ssr || {};
    const serverPath = path.join(
      api.paths!.absOutputPath,
      OUTPUT_SERVER_FILENAME,
    );
    // if dev clear cache
    if (api.env === 'development') {
      delete require.cache[serverPath];
    }

    console.time(`[SSR] ${stream ? 'stream' : ''} render ${req.url} start`);

    const render = require(serverPath);
    const { html, error } = await render({
      // with query
      path: req.url,
      htmlTemplate: defaultHtml,
      mountElementId: api.config?.mountElementId,
    });

    console.timeEnd(`[SSR] ${stream ? 'stream' : ''} render ${req.url} start`);

    if (!error) {
      return html;
    }
    return defaultHtml;
  });

  // 修改
  api.chainWebpack(async (config, opts) => {
    const { paths } = api;
    const { type } = opts;
    const serverEntryPath = path.join(paths!.absTmpPath, 'core/server.ts');
    if (type === BundlerConfigType.ssr) {
      config.entryPoints.clear();
      config.entry(CHUNK_NAME).add(serverEntryPath);
      config.target('node');
      config.name(CHUNK_NAME);

      config.output
        .filename(OUTPUT_SERVER_FILENAME)
        .libraryExport('default')
        .chunkFilename('[name].server.js')
        .publicPath(api.config!.publicPath)
        .pathinfo(false)
        .libraryTarget('commonjs2');

      config.plugin('define').tap(([args]) => [
        {
          ...args,
          'window.routerBase': JSON.stringify(api.config.base),
          'process.env.__IS_SERVER': true,
        },
      ]);

      if (config.plugins.has('extract-css')) {
        config.plugins.delete('extract-css');
      }
      ['css', 'less'].forEach((lang) => {
        const langRule = config.module.rule(lang);
        [
          langRule.oneOf('css-modules').resourceQuery(/modules/),
          langRule.oneOf('css'),
        ].forEach((rule) => {
          if (rule.uses.has('extract-css-loader')) {
            rule.uses.delete('extract-css-loader');
            rule.use('css-loader').tap((options) => ({
              ...options,
              // https://webpack.js.org/loaders/css-loader/#onlylocals
              onlyLocals: true,
            }));
          }
        });
      });

      config.externals([]);

      // avoid client and server analyze conflicts
      if (process.env.ANALYZE) {
        if (config.plugins.has('bundle-analyzer')) {
          config.plugins.delete('bundle-analyzer');
        }
      }
      return config;
    }
    // avoid client and server analyze conflicts
    if (process.env.ANALYZE_SSR) {
      if (config.plugins.has('bundle-analyzer')) {
        config.plugins.delete('bundle-analyzer');
      }
    }
    return config;
  });

  // runtime ssr plugin
  api.addRuntimePluginKey(() => 'ssr');

  api.addUmiExports(() => [
    {
      exportAll: true,
      source: `../${TMP_PLUGIN_DIR}/${CLIENT_EXPORTS}`,
    },
  ]);

  /**
   * replace default html string when build success
   * [WARN] must exec before prerender plugin
   */
  api.onBuildComplete(({ err }) => {
    if (!err) {
      const { serverFile, htmlFile, serverFilePath } = getDistContent(
        api.paths!.absOutputPath,
      );

      if (serverFile.indexOf(DEFAULT_HTML_PLACEHOLDER) > -1) {
        // has placeholder
        const newServerFile = serverFile.replace(
          new RegExp(DEFAULT_HTML_PLACEHOLDER, 'g'),
          JSON.stringify(htmlFile),
        );
        fs.writeFileSync(serverFilePath, newServerFile, 'utf-8');
      }
    }
  });
};
