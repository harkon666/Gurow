# The frontend server as `bun run build` leaves it in frontend/.output (built before
# deploying, since the build needs the Rust toolchain for the editor's WebAssembly).
FROM node:24-slim
WORKDIR /app
COPY frontend/.output ./.output
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
