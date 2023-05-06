import merge from "webpack-merge";
import common from "./webpack.common";

import { DefinePlugin } from "webpack";

import * as path from "path";

const config = merge(common, {
    mode: "development",
    devtool: "source-map",

    devServer: {
        devMiddleware: { publicPath: "http://localhost:3000" },
        static: { directory: path.resolve(__dirname, "../assets") },
        historyApiFallback: true,
        port: 3000,
        hot: true
    },

    output: {
        path: path.resolve(__dirname, "../dist"),
        filename: "assets/js/[name].[chunkhash:8].js",
        clean: true
    },

    plugins: [
        new DefinePlugin({ API_URL: "\"http://localhost:8080/api\"" })
    ]
});

export default config;
