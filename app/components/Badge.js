const KINDS = {
  live: ['ok', 'Live'],
  semi: ['info', 'Part live'],
  fixed: ['mute', 'As signed'],
};
const TITLES = {
  live: 'Rebuilt from Zoho Books at every refresh',
  semi: 'Some figures are rebuilt from Zoho Books, the rest are as signed',
  fixed: "The auditors' own working, shown as signed",
};

/** Says whether a sheet is rebuilt from Zoho Books (Live), partly (Part live) or shown exactly as the auditors signed it. */
export default function Badge({ status }) {
  const [cls, text] = KINDS[status] ?? ['mute', status];
  return <span className={`chip ${cls}`} title={TITLES[status] ?? ''}>{text}</span>;
}
