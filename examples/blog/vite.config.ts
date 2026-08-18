import { defineConfig } from 'vite';

/**
 * The port is pinned, and that is the interesting line in this file.
 *
 * 🔴 A browser calling a BaseCLF deployment sends an Origin header, and the
 * deployment answers only origins it was told about. That list is set when the
 * deployment is created: `create-baseclf` asks for the front end origin as one of
 * its two questions, long before anybody has started a dev server and found out
 * which port it took.
 *
 * Vite defaults to 5173. This example ran there first and every request failed with
 * "No 'Access-Control-Allow-Origin' header is present", which reads as the API being
 * down rather than as a list needing one more line. So the port is stated here, and
 * whichever port you choose has to be the origin the deployment knows.
 *
 * Change it and change the deployment to match, or the page will load and the data
 * will not.
 */
export default defineConfig({
  server: { port: 4321, strictPort: true },
});
