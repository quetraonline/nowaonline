# Nowa Online World — Knight Online Server Finder

A responsive, static first version of a Knight Online server discovery page, built for Vercel.

## Included in this first version

- Responsive dark fantasy / gold visual theme
- Server search by name and keywords
- Filters for server type, game version, level cap, opening status, date and play style
- Quick category chips
- Sort by recommendation, newest date and name
- Grid and list views
- Favorites stored in the current browser
- Server detail modal
- Add-server form (browser-local preview only)

## Important data note

The visible records are clearly marked **ÖRNEK** and are placeholder/demo data. They are not verified live server listings. The add-server form currently stores entries in the visitor's browser using localStorage; it does not submit to a shared database.

## Next production steps

1. Choose and connect a shared database (for example Supabase).
2. Add a server submission workflow and moderation/admin approval.
3. Replace placeholder records with verified server data.
4. Add official server website / Discord links, opening countdowns, banner uploads and report/update controls.
5. Configure spam protection and validation before public submissions.

## Deploy

The GitHub repository is connected to the Vercel project. Commits pushed to `main` trigger Vercel deployment automatically.

- GitHub: https://github.com/quetraonline/nowaonline
- Vercel project: https://vercel.com/quetraonline/nowaonline
