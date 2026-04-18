const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const portsConfig = require('../ports.config.json');

module.exports = (env, argv) => {
  const isDevelopment = argv.mode === 'development';

  return {
    entry: './src/index.tsx',

    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'bundle.js',
      publicPath: isDevelopment ? '/' : './',
      clean: true
    },

    module: {
      rules: [
        {
          test: /\.(js|jsx|ts|tsx)$/,
          exclude: /node_modules/,
          use: {
            loader: 'swc-loader',
            options: {
              jsc: {
                parser: {
                  syntax: 'typescript',
                  tsx: true,
                  dynamicImport: true,
                },
                transform: {
                  react: {
                    runtime: 'automatic',
                  },
                },
                target: 'es2017',
              },
            },
          },
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader', 'postcss-loader']
        },
        {
          test: /\.module\.(scss|sass)$/,
          use: [
            'style-loader',
            'css-modules-types-loader',
            {
              loader: 'css-loader',
              options: {
                modules: {
                  localIdentName: '[name]__[local]___[hash:base64:5]'
                }
              }
            },
            'sass-loader'
          ]
        }
      ]
    },

    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
      alias: {
        '@': path.resolve(__dirname, 'src'),
        [path.resolve(__dirname, 'node_modules/@pierre/diffs/node_modules/shiki/dist/bundle-full.mjs')]:
          path.resolve(__dirname, 'node_modules/@pierre/diffs/node_modules/shiki/dist/bundle-web.mjs'),
        [path.resolve(__dirname, 'node_modules/@pierre/diffs/node_modules/shiki/dist/langs.mjs')]:
          path.resolve(__dirname, 'src/shims/shiki-langs-noop.mjs'),
      }
    },

    plugins: [
      new HtmlWebpackPlugin({
        template: './public/index.html',
        filename: 'index.html',
        favicon: './public/favicon.ico'
      }),
      new CopyWebpackPlugin({
        patterns: [
          {
            from: 'public',
            to: '.',
            globOptions: { ignore: ['**/index.html', '**/favicon.ico'] },
          },
        ],
      }),
    ],

    cache: isDevelopment ? { type: 'filesystem' } : false,

    devtool: isDevelopment ? 'eval-cheap-module-source-map' : false,

    devServer: {
      static: { directory: path.join(__dirname, 'public') },
      compress: true,
      port: portsConfig.frontend.dev,
      hot: true,
      open: false,
      historyApiFallback: true,
      proxy: {
        '/api': {
          target: `http://localhost:${portsConfig.backend.dev}`,
          changeOrigin: true,
        },
      },
    }
  };
};
