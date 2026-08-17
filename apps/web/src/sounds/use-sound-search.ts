import { useEffect } from "react";
import { useSoundsStore } from "@/sounds/sounds-store";

// Kneecap: the Freesound-backed search proxy (`/api/sounds/search`) was
// removed — it called out to freesound.org, an external network
// dependency this offline-first app cannot have. Sound search is
// hard-disabled here rather than deleted so the UI shell and store wiring
// survive for a future locally-bundled sound library (plan M8: "Ship a
// small bundled local sound set instead"). No fetch is ever made.
const SOUND_SEARCH_DISABLED_MESSAGE =
	"Sound search is unavailable in this offline build.";

export function useSoundSearch({
	query,
	commercialOnly: _commercialOnly,
}: {
	query: string;
	commercialOnly: boolean;
}) {
	const {
		searchResults,
		isSearching,
		searchError,
		hasNextPage,
		isLoadingMore,
		totalCount,
		setSearchResults,
		setSearching,
		setSearchError,
		setLastSearchQuery,
	} = useSoundsStore();

	// Pagination against a removed remote API is meaningless; there is
	// never a next page, so loadMore is a no-op.
	const loadMore = async () => {};

	useEffect(() => {
		setSearchResults({ results: [] });
		setSearching({ searching: false });
		setSearchError({
			error: query.trim() ? SOUND_SEARCH_DISABLED_MESSAGE : null,
		});
		setLastSearchQuery({ query });
	}, [query, setSearchResults, setSearching, setSearchError, setLastSearchQuery]);

	return {
		results: searchResults,
		isLoading: isSearching,
		error: searchError,
		loadMore,
		hasNextPage,
		isLoadingMore,
		totalCount,
	};
}
