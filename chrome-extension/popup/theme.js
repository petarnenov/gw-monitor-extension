/**
 * Theme management (light/dark/auto).
 */
async function applyTheme() {
    const { theme } = await AppStorage.get('theme');
    const btn = document.getElementById('theme-btn');
    if (theme) {
        document.documentElement.setAttribute('data-theme', theme);
        btn.textContent = theme === 'dark' ? '\u2600' : '\u263E';
    } else {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        btn.textContent = prefersDark ? '\u2600' : '\u263E';
    }
}

async function toggleTheme() {
    const { theme } = await AppStorage.get('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    let next;
    if (!theme) {
        next = prefersDark ? 'light' : 'dark';
    } else if (theme === 'dark') {
        next = 'light';
    } else {
        next = 'dark';
    }

    await AppStorage.set({ theme: next });
    document.documentElement.setAttribute('data-theme', next);
    document.getElementById('theme-btn').textContent = next === 'dark' ? '\u2600' : '\u263E';
}
