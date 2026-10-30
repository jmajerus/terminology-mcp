import type { Store } from './store.js';

export function seedDemo(store: Store) {
  if (store.schemes().length) return;
  store.db.transaction(() => {
    store.addScheme({ id: 'subjects', label: 'Subjects', hierarchy: 'tree',
      description: 'Sample subject taxonomy. These terms are demonstration data, not an import.',
      admissionTest: 'Add a top term when a body of material justifies it.' });
    store.addScheme({ id: 'human-work', label: 'Human work', hierarchy: 'poly',
      description: 'Sample concepts with multiple broader terms.' });
    const add = (label: string, parent?: string, scopeNote = '', status = 'active') => store.addTerm({
      scheme: 'subjects', label, broader: parent ? [parent] : [], scopeNote, status,
    });
    const society = add('Society & politics', undefined, 'Institutions, collective life, and the distribution of power.');
    const politics = add('Political behavior', society.id, 'How people participate in, respond to, and shape political life.');
    add('Political participation', politics.id, 'Voting, organizing, and other forms of participation in politics.');
    add('Public opinion', politics.id, 'The formation and expression of public attitudes.');
    add('Social movements', society.id, 'Collective efforts directed toward social change.');
    const science = add('Sciences & mathematics');
    const biology = add('Biology', science.id, 'Living organisms and the processes of life.');
    add('Ecology', biology.id, 'Relationships among organisms and their environments.');
    add('Evolution', biology.id, 'Changes in populations over generations.');
    add('Mathematics', science.id);
    const arts = add('Arts & humanities');
    add('Literature', arts.id, 'Written works considered as art and cultural expression.');
    add('Ethics', arts.id, 'Questions about how to act and how to live.');
    add('Creative practice', arts.id, 'The processes and habits of making.', 'provisional');
    const agency = store.addTerm({ scheme: 'human-work', label: 'Agency', status: 'active',
      scopeNote: 'The capacity to act and make choices.', relations: [{ type: 'related', target: politics.id }] });
    const connection = store.addTerm({ scheme: 'human-work', label: 'Connection', status: 'active' });
    store.addTerm({ scheme: 'human-work', label: 'Solidarity', status: 'active', broader: [agency.id, connection.id],
      scopeNote: 'Acting together through shared commitments.' });
  })();
}
