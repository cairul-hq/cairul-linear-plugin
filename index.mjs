import {
  bearer,
  check,
  connection,
  error,
  includesAll,
  matchesState,
  query,
  service,
  stateOption,
  target,
  text,
  verdict,
  z,
} from '@cairul/pdk';

export default function linear(options) {
  const api = connection(options, {
    prefix: 'LINEAR',
    baseUrl: 'https://api.linear.app',
    tokenEnv: 'LINEAR_API_KEY',
    required: true,
    authModes: { 'api-key': (token) => ({ authorization: token }), bearer },
  });
  function issueCheck(fields, shape, evaluate) {
    return check(z.strictObject({ issue: text.optional(), ...shape }), (config, context) =>
      service(async () => {
        const id = target(config.issue, context.workItemUrl, ['linear.app', api.host], /\/issue\/([^/]+)(?:\/|$)/);
        const response = await query(
          api,
          'graphql',
          { query: `query CairulIssue($id: String!) { issue(id: $id) { ${fields} } }`, variables: { id } },
          context.signal
        );
        if (response.errors?.length || !response.data?.issue) return error('Linear could not resolve the issue.');
        return evaluate(response.data.issue, config);
      })
    );
  }
  return {
    checkKinds: {
      'linear.issue-state': issueCheck('state { name }', { state: stateOption }, (issue, { state }) =>
        matchesState(issue.state?.name, state, 'Issue')
      ),
      'linear.issue-labels': issueCheck(
        'labels(first: 100) { nodes { name } pageInfo { hasNextPage } }',
        { labels: z.array(text).min(1) },
        (issue, { labels }) =>
          issue.labels?.pageInfo?.hasNextPage
            ? error('Linear returned an incomplete label list.')
            : includesAll(
                issue.labels?.nodes?.map((label) => label.name),
                labels,
                'issue labels'
              )
      ),
      'linear.no-blockers': issueCheck(
        'inverseRelations(first: 100) { nodes { type issue { state { type } } } pageInfo { hasNextPage } }',
        {},
        ({ inverseRelations: relations }) => {
          if (relations?.pageInfo?.hasNextPage !== false || !Array.isArray(relations.nodes)) {
            return error('Linear returned an incomplete blocker list.');
          }
          const pending = relations.nodes.filter(
            (relation) => relation.type === 'blocks' && !['completed', 'canceled'].includes(relation.issue?.state?.type)
          ).length;
          return verdict(pending === 0, `${pending} blocking issues remain open.`);
        }
      ),
      'linear.sub-issues-complete': issueCheck(
        'children(first: 100) { nodes { state { type } } pageInfo { hasNextPage } }',
        {},
        (issue) => {
          const children = issue.children;
          if (children?.pageInfo?.hasNextPage !== false || !Array.isArray(children.nodes))
            return error('Linear returned an incomplete sub-issue list.');
          const pending = children.nodes.filter((child) => child.state?.type !== 'completed').length;
          return verdict(
            children.nodes.length > 0 && pending === 0,
            pending
              ? `${pending} sub-issues remain open.`
              : children.nodes.length
                ? 'Sub-issues complete.'
                : 'No sub-issues found.'
          );
        }
      ),
    },
  };
}
