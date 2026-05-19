import {defineConfig} from "vite";

const gatewayBase = "/app/FanControlServer/";

export default defineConfig({
    base: gatewayBase,
    build: {
        outDir: "../backend/web",
        emptyOutDir: true
    },
    server: {
        port: 5173,
        host: true,
        proxy: {
            [gatewayBase + "api"]: {
                target: "http://127.0.0.1:19527",
                changeOrigin: true,
                ws: true,
                rewrite: (path) => path.replace(new RegExp(`^${gatewayBase}`), "/"),
            },
        },
    },
    preview: {
        port: 4173,
        host: true,
        proxy: {
            [gatewayBase + "api"]: {
                target: "http://127.0.0.1:19527",
                changeOrigin: true,
                ws: true,
                rewrite: (path) => path.replace(new RegExp(`^${gatewayBase}`), "/"),
            },
        },
    },
});