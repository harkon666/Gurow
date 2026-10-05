Welcome to your new TanStack Start app!

# Getting Started

To run this application:

```bash
bun install
bun --bun run dev
```

## Routes and backend (T15)

| Route | Purpose |
| --- | --- |
| `/` | Product entry: sign in or create an Account, then enter its Personal Workspace |
| `/workspaces/$workspaceId` | The signed-in owner's Personal Workspace; other Accounts see "not available". It rechecks the Account when another tab signs in or out (`src/lib/session.ts`) and when the tab is resumed |
| `/paths/$pathId` | One personal Learning Path for its owner: the editor autosaves the document (T16), and the learning panels track Task completion, rewards, Mastery declarations, XP Thresholds and Access Overrides, showing only backend-confirmed records (T17) |
| `/coach` | The owning-Coach context: the Coach Workspaces the Account owns and a form to create one (T18). The header's Personal/Coaching switch changes context; coach pages never read personal data |
| `/coach/workspaces/$workspaceId` | One Coach Workspace and its Learning Paths, for its owner only |
| `/coach/paths/$pathId` | A Path's Draft in the same editor, with Draft rules: Required/Enrichment Tasks, rewards, Optional Skills and XP Thresholds. "Publish Version N" publishes a saved Draft or lists the blocked required Skills and their unmet requirements (T19). Without a Draft, the latest published Version is shown read-only with "Prepare Version N+1 as a Draft" |
| `/coach/versions/$versionId` | One published Version, read-only, for the owning Coach (T19) |
| `/editor` | The P1 local-fixture editor (localStorage only, no Account data) until T16 |
| `/api/*` | Same-origin forwarder to the Hono backend at `GUROW_API_ORIGIN` (default `http://127.0.0.1:3001`) |

For local sign-in, run the backend (`cd ../backend && bun run dev`, with `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL=http://localhost:3000` in `backend/.env`) next to `bun run dev`. Verification links are printed in the backend log. `bun run check:t15` builds the app and runs the browser sign-in check against a separate `gurow_browser_test` database. `bun run check:t17` does the same for the personal learning flow on `gurow_t17_browser_test`. `bun run check:t18` covers Coach Workspaces and Drafts on `gurow_t18_browser_test`, and `bun run check:t19` publication and new Versions on `gurow_t19_browser_test`.

# Building For Production

To build this application for production:

```bash
bun --bun run build
```

## Styling

This project uses [Tailwind CSS](https://tailwindcss.com/) for styling.

### Removing Tailwind CSS

If you prefer not to use Tailwind CSS:

1. Remove the demo pages in `src/routes/demo/`
2. Replace the Tailwind import in `src/styles.css` with your own styles
3. Remove `tailwindcss()` from the plugins array in `vite.config.ts`
4. Remove `@tailwindcss/vite` and `tailwindcss` from `package.json`


## Deploy with Nitro

This project uses Nitro as a generic server adapter, so it can run on any Node-compatible host.

```bash
npm run build
node dist/server/index.mjs
```

The build output is a self-contained Node server. To deploy, push the `dist/` directory to your host (Render, Fly.io, your own VPS, etc.) and run the server command above.

For host-specific presets (Vercel, Netlify, Cloudflare, AWS Lambda, etc.) and tuning, see https://v3.nitro.build/deploy.



## Routing

This project uses [TanStack Router](https://tanstack.com/router) with file-based routing. Routes are managed as files in `src/routes`.

### Adding A Route

To add a new route to your application just add a new file in the `./src/routes` directory.

TanStack will automatically generate the content of the route file for you.

Now that you have two routes you can use a `Link` component to navigate between them.

### Adding Links

To use SPA (Single Page Application) navigation you will need to import the `Link` component from `@tanstack/react-router`.

```tsx
import { Link } from "@tanstack/react-router";
```

Then anywhere in your JSX you can use it like so:

```tsx
<Link to="/about">About</Link>
```

This will create a link that will navigate to the `/about` route.

More information on the `Link` component can be found in the [Link documentation](https://tanstack.com/router/v1/docs/framework/react/api/router/linkComponent).

### Using A Layout

In the File Based Routing setup the layout is located in `src/routes/__root.tsx`. Anything you add to the root route will appear in all the routes. The route content will appear in the JSX where you render `{children}` in the `shellComponent`.

Here is an example layout that includes a header:

```tsx
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'My App' },
    ],
  }),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <header>
          <nav>
            <Link to="/">Home</Link>
            <Link to="/about">About</Link>
          </nav>
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  ),
})
```

More information on layouts can be found in the [Layouts documentation](https://tanstack.com/router/latest/docs/framework/react/guide/routing-concepts#layouts).

## Server Functions

TanStack Start provides server functions that allow you to write server-side code that seamlessly integrates with your client components.

```tsx
import { createServerFn } from '@tanstack/react-start'

const getServerTime = createServerFn({
  method: 'GET',
}).handler(async () => {
  return new Date().toISOString()
})

// Use in a component
function MyComponent() {
  const [time, setTime] = useState('')
  
  useEffect(() => {
    getServerTime().then(setTime)
  }, [])
  
  return <div>Server time: {time}</div>
}
```

## API Routes

You can create API routes by using the `server` property in your route definitions:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

export const Route = createFileRoute('/api/hello')({
  server: {
    handlers: {
      GET: () => json({ message: 'Hello, World!' }),
    },
  },
})
```

## Data Fetching

There are multiple ways to fetch data in your application. You can use TanStack Query to fetch data from a server. But you can also use the `loader` functionality built into TanStack Router to load the data for a route before it's rendered.

For example:

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/people')({
  loader: async () => {
    const response = await fetch('https://swapi.dev/api/people')
    return response.json()
  },
  component: PeopleComponent,
})

function PeopleComponent() {
  const data = Route.useLoaderData()
  return (
    <ul>
      {data.results.map((person) => (
        <li key={person.name}>{person.name}</li>
      ))}
    </ul>
  )
}
```

Loaders simplify your data fetching logic dramatically. Check out more information in the [Loader documentation](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#loader-parameters).


# Demo files

Files prefixed with `demo` can be safely deleted. They are there to provide a starting point for you to play around with the features you've installed.


# Learn More

You can learn more about all of the offerings from TanStack in the [TanStack documentation](https://tanstack.com).

For TanStack Start specific documentation, visit [TanStack Start](https://tanstack.com/start).
