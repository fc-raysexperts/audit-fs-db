import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/ibm-plex-serif/500.css';
import '@fontsource/ibm-plex-serif/600.css';
import '@fontsource/ibm-plex-serif/700.css';
import './globals.css';
import Rail from './components/Rail';
import { getView } from './lib/data';

export const metadata = {
  title: 'RPEL financial statements',
  description: 'Rays Power Experts Limited: audited-style financial statements, live from Zoho Books',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

// Applies the saved unit (rupees / lakhs / crores) before the page paints, so it does not flash.
const unitScript = "try{var u=localStorage.getItem('afs-unit');if(u==='lakh'||u==='crore')document.documentElement.dataset.unit=u}catch(e){}";

export default async function RootLayout({ children }) {
  const view = await getView();
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: unitScript }} /></head>
      <body suppressHydrationWarning>
        <a className="skip" href="#main">Skip to the content</a>
        <div className="shell">
          <Rail view={view} />
          <main className="main" id="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
