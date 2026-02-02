export const dataTable = async (params, model, additionalPipeline = []) => {
	const { pageIndex, pageSize, sort, matchQuery = [] } = params
	const _matchQuery = matchQuery.reduce((q, i) => ({ ...q, ...i["$match"] }), {}) || {}
	const total = pageIndex === 1 ? await model.countDocuments(_matchQuery) : null

	const paginationPipeline = params.shouldFetchAll
		? []
		: [
				{
					$sort: {
						[sort?.key || "_id"]: sort?.order === "asc" ? 1 : -1
					}
				},
				{
					$skip: (pageIndex - 1) * pageSize
				},
				{
					$limit: pageSize
				}
		  ]

	const pipeline = [...matchQuery, ...paginationPipeline, ...additionalPipeline]
	const data = await model.aggregate(pipeline)
	return { data, total }
}
