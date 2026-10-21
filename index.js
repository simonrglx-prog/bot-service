require('dotenv').config();
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags,
} = require('discord.js');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, SHEET_URL, SHEET_KEY, ALLOWED_ROLE_ID } = process.env;

// ---------- Données ----------
let cache = { at: 0, rows: [] };

async function getRows() {
  if (Date.now() - cache.at < 60_000) return cache.rows; // cache 60 s
  const url = `${SHEET_URL}?action=data&key=${encodeURIComponent(SHEET_KEY)}`;
  const res = await fetch(url, { redirect: 'follow' });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  cache = { at: Date.now(), rows: data.rows };
  return data.rows;
}

// ligne = [nigend, nom, ymd, dateAffichée, début, fin, minutes|null]
const fmt = (min) => `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
const sansAccent = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function maintenantParis() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
}
const ymdDe = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

// "JJ/MM/AAAA" -> ymd
function lireDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  return m ? +m[3] * 10000 + +m[2] * 100 + +m[1] : null;
}
const ecrireYmd = (n) =>
  `${String(n % 100).padStart(2, '0')}/${String(Math.floor(n / 100) % 100).padStart(2, '0')}/${Math.floor(n / 10000)}`;

function periode(interaction) {
  const debutSaisi = interaction.options.getString('debut');
  const finSaisie = interaction.options.getString('fin');
  if (debutSaisi || finSaisie) {
    const d = lireDate(debutSaisi), f = lireDate(finSaisie);
    if ((debutSaisi && !d) || (finSaisie && !f)) return { erreur: 'Format de date invalide. Utilise JJ/MM/AAAA.' };
    return { debut: d || 0, fin: f || 99999999 };
  }
  const now = maintenantParis();
  const dec = interaction.options.getString('periode') === 'precedent' ? -1 : 0;
  const premier = new Date(now.getFullYear(), now.getMonth() + dec, 1);
  const dernier = new Date(now.getFullYear(), now.getMonth() + dec + 1, 0);
  return { debut: ymdDe(premier), fin: ymdDe(dernier) };
}

function grouper(liste) {
  const map = {};
  for (const r of liste) {
    const g = (map[r[0]] ||= { nigend: r[0], nom: r[1], vac: 0, min: 0 });
    g.nom = r[1];
    g.vac += 1;
    g.min += r[6] || 0;
  }
  return Object.values(map).sort((a, b) => b.min - a.min);
}

function pied(liste, p) {
  const bad = liste.filter((r) => r[6] === null).length;
  const txt = `Période : ${p.debut ? ecrireYmd(p.debut) : '…'} → ${p.fin < 99999999 ? ecrireYmd(p.fin) : '…'}`;
  return bad ? `${txt} · ${bad} rapport(s) illisible(s) non compté(s)` : txt;
}

function listeTexte(groupes, max = 25) {
  const lignes = groupes.slice(0, max).map((g) => `${g.nigend.padEnd(8)} ${fmt(g.min).padStart(8)}  ${g.nom}`.slice(0, 70));
  if (groupes.length > max) lignes.push(`… et ${groupes.length - max} autre(s)`);
  return '```\n' + lignes.join('\n') + '\n```';
}

// ---------- Commandes ----------
const optsPeriode = (c) => c
  .addStringOption((o) => o.setName('periode').setDescription('Période (par défaut : mois en cours)')
    .addChoices({ name: 'Mois en cours', value: 'courant' }, { name: 'Mois précédent', value: 'precedent' }))
  .addStringOption((o) => o.setName('debut').setDescription('Date de début JJ/MM/AAAA (remplace la période)'))
  .addStringOption((o) => o.setName('fin').setDescription('Date de fin JJ/MM/AAAA (remplace la période)'));

const commandes = [
  optsPeriode(new SlashCommandBuilder().setName('heures').setDescription("Heures de service d'un gendarme")
    .addStringOption((o) => o.setName('nigend').setDescription("Numéro d'identification (NIGEND)").setRequired(true))),
  optsPeriode(new SlashCommandBuilder().setName('grade').setDescription("Heures de service d'un grade")
    .addStringOption((o) => o.setName('grade').setDescription('Grade (ou mot du grade)').setRequired(true))),
  optsPeriode(new SlashCommandBuilder().setName('global').setDescription('Heures de service de tout le groupement')),
].map((c) => c.toJSON());

async function repondre(interaction) {
  const p = periode(interaction);
  if (p.erreur) return interaction.editReply(p.erreur);

  const rows = (await getRows()).filter((r) => r[2] !== null && r[2] >= p.debut && r[2] <= p.fin);
  const embed = new EmbedBuilder().setColor(0x14264a).setFooter({ text: pied(rows, p) });

  if (interaction.commandName === 'heures') {
    const n = interaction.options.getString('nigend').replace(/\s+/g, '').toUpperCase();
    const siens = rows.filter((r) => r[0] === n);
    if (!siens.length) {
      return interaction.editReply({ embeds: [embed.setTitle(`NIGEND ${n}`).setDescription('Aucune vacation sur cette période.')] });
    }
    const g = grouper(siens)[0];
    const detail = siens.sort((a, b) => a[2] - b[2]).slice(-15)
      .map((r) => `${r[3]}  ${r[4]} → ${r[5]}  **${r[6] === null ? 'à vérifier' : fmt(r[6])}**`).join('\n');
    embed.setTitle(g.nom).setDescription(`**${fmt(g.min)}** sur **${g.vac}** vacation(s)\n\n${detail}`)
      .setAuthor({ name: `NIGEND ${n}` });
  } else if (interaction.commandName === 'grade') {
    const mot = sansAccent(interaction.options.getString('grade').trim());
    const gg = grouper(rows.filter((r) => sansAccent(r[1]).includes(mot)));
    if (!gg.length) return interaction.editReply({ embeds: [embed.setDescription('Aucun résultat pour ce grade sur la période.')] });
    const tot = gg.reduce((s, g) => s + g.min, 0);
    embed.setTitle(`Grade : ${interaction.options.getString('grade')}`)
      .setDescription(`**${fmt(tot)}** · ${gg.length} gendarme(s)\n${listeTexte(gg)}`);
  } else {
    const gg = grouper(rows);
    const tot = gg.reduce((s, g) => s + g.min, 0);
    const vac = gg.reduce((s, g) => s + g.vac, 0);
    embed.setTitle('Groupement de Gendarmerie du Nord')
      .setDescription(`**${fmt(tot)}** · ${vac} vacation(s) · ${gg.length} gendarme(s)\n${listeTexte(gg)}`);
  }
  return interaction.editReply({ embeds: [embed] });
}

// ---------- Démarrage ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  const rest = new REST().setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commandes });
  console.log(`Bot connecté : ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (ALLOWED_ROLE_ID && !interaction.member?.roles?.cache?.has(ALLOWED_ROLE_ID)) {
    return interaction.reply({ content: 'Commande réservée aux Ressources Humaines.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // réponse visible par toi seul
  try {
    await repondre(interaction);
  } catch (e) {
    console.error(e);
    await interaction.editReply(`Erreur : ${e.message}`);
  }
});

client.login(DISCORD_TOKEN);
