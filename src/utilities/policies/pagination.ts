import { __rest } from "tslib";

import { FieldPolicy, Reference } from '../../cache';

type KeyArgs = FieldPolicy<any>["keyArgs"];

// A very basic pagination field policy that always concatenates new
// results onto the existing array, without examining options.args.
export function concatPagination<T = Reference>(
  keyArgs: KeyArgs = false,
): FieldPolicy<T[]> {
  return {
    keyArgs,
    merge(existing, incoming) {
      return existing ? [
        ...existing,
        ...incoming,
      ] : incoming;
    },
  };
}

// A basic field policy that uses options.args.offset as the starting
// point to display output.  It uses either the length of the incoming
// data to determine the length of the returned merged result.
// If your arguments are called something different (like args.{start,limit}),
// it is suggested that you use this function as a basis for your own 
// implementation and make the necessary changes.
export function offsetLimitPagination<T = Reference>(
  keyArgs: KeyArgs = false,
): FieldPolicy<T[]> {
  return {
    keyArgs,
    merge(existing, incoming, { args }) {
      const merged = existing ? existing.slice(0) : [];
      const start = args ? args.offset : merged.length;
      const end = start + incoming.length;
      for (let i = start; i < end; ++i) {
        merged[i] = incoming[i - start];
      }
      return merged;
    },
  };
}

type TEdge<TNode> = {
  cursor?: string;
  node: TNode;
} | Reference;

// This object is an internal structure that's slightly different from the
// GraphQL response format for edges. Each actual edge gets wrapped in a
// wrapper object that can safely store a cursor string (possibly inferred
// from pageInfo), which makes things easier when the actual edge happens
// to be a normalized Reference, since updating fields of an object behind
// a Reference is tricky in a merge function.
type TEdgeWrapper<TNode> = {
  cursor?: string;
  edge: TEdge<TNode>;
};

type TPageInfo = {
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  startCursor: string;
  endCursor: string;
};

type TExistingRelay<TNode> = Readonly<{
  wrappers: TEdgeWrapper<TNode>[];
  pageInfo: TPageInfo;
}>;

type TIncomingRelay<TNode> = {
  edges?: TEdge<TNode>[];
  pageInfo?: TPageInfo;
};

type RelayFieldPolicy<TNode> = FieldPolicy<
  TExistingRelay<TNode>,
  TIncomingRelay<TNode>,
  TIncomingRelay<TNode>
>;

// As proof of the flexibility of field policies, this function generates
// one that handles Relay-style pagination, without Apollo Client knowing
// anything about connections, edges, cursors, or pageInfo objects.
export function relayStylePagination<TNode = Reference>(
  keyArgs: KeyArgs = false,
): RelayFieldPolicy<TNode> {
  return {
    keyArgs,

    read(existing, { canRead, readField }) {
      if (!existing) return;

      const edges: TEdge<TNode>[] = [];
      let startCursor = "";
      let endCursor = "";
      existing.wrappers.forEach(wrapper => {
        // Edges themselves could be Reference objects, so it's important
        // to use readField to access the wrapper.edge.node property.
        if (canRead(readField("node", wrapper.edge))) {
          edges.push(wrapper.edge);
          if (wrapper.cursor) {
            startCursor = startCursor || wrapper.cursor;
            endCursor = wrapper.cursor;
          }
        }
      });

      return {
        // Some implementations return additional Connection fields, such
        // as existing.totalCount. These fields are saved by the merge
        // function, so the read function should also preserve them.
        ...getExtras(existing),
        edges,
        pageInfo: {
          ...existing.pageInfo,
          startCursor,
          endCursor,
        },
      };
    },

    merge(existing = makeEmptyData(), incoming, { args, readField }) {
      // Convert incoming.edges to an array of TEdgeWrapper objects, so
      // that we can merge the incoming wrappers into existing.wrappers.
      const incomingWrappers: TEdgeWrapper<TNode>[] =
        incoming.edges ? incoming.edges.map(edge => ({
          edge,
          // In case edge is a Reference, we lift out its cursor field and
          // store it in the TEdgeWrapper object.
          cursor: readField<string>("cursor", edge),
        })) : [];

      if (incoming.pageInfo) {
        // In case we did not request the cursor field for edges in this
        // query, we can still infer some of those cursors from pageInfo.
        const { startCursor, endCursor } = incoming.pageInfo;
        const firstWrapper = incomingWrappers[0];
        if (firstWrapper && startCursor) {
          firstWrapper.cursor = startCursor;
        }
        const lastWrapper = incomingWrappers[incomingWrappers.length - 1];
        if (lastWrapper && endCursor) {
          lastWrapper.cursor = endCursor;
        }
      }

      let prefix = existing.wrappers;
      let suffix: typeof prefix = [];

      if (args && args.after) {
        const index = prefix.findIndex(wrapper => wrapper.cursor === args.after);
        if (index >= 0) {
          prefix = prefix.slice(0, index + 1);
          // suffix = []; // already true
        }
      } else if (args && args.before) {
        const index = prefix.findIndex(wrapper => wrapper.cursor === args.before);
        suffix = index < 0 ? prefix : prefix.slice(index);
        prefix = [];
      } else if (incoming.edges) {
        // If we have neither args.after nor args.before, the incoming
        // edges cannot be spliced into the existing edges, so they must
        // replace the existing edges. See #6592 for a motivating example.
        prefix = [];
      }

      const wrappers = [
        ...prefix,
        ...incomingWrappers,
        ...suffix,
      ];

      const firstWrapper = wrappers[0];
      const lastWrapper = wrappers[wrappers.length - 1];

      const pageInfo: TPageInfo = {
        ...incoming.pageInfo,
        ...existing.pageInfo,
        startCursor: firstWrapper && firstWrapper.cursor || "",
        endCursor: lastWrapper && lastWrapper.cursor || "",
      };

      if (incoming.pageInfo) {
        const { hasPreviousPage, hasNextPage } = incoming.pageInfo;
        // Keep existing.pageInfo.has{Previous,Next}Page unless the
        // placement of the incoming edges means incoming.hasPreviousPage
        // or incoming.hasNextPage should become the new values for those
        // properties in existing.pageInfo.
        if (!prefix.length && hasPreviousPage !== void 0) {
          pageInfo.hasPreviousPage = hasPreviousPage;
        }
        if (!suffix.length && hasNextPage !== void 0) {
          pageInfo.hasNextPage = hasNextPage;
        }
      }

      return {
        ...getExtras(existing),
        ...getExtras(incoming),
        wrappers,
        pageInfo,
      };
    },
  };
}

// Returns any unrecognized properties of the given object.
const getExtras = (obj: Record<string, any>) => __rest(obj, notExtras);
const notExtras = ["edges", "wrappers", "pageInfo"];

function makeEmptyData(): TExistingRelay<any> {
  return {
    wrappers: [],
    pageInfo: {
      hasPreviousPage: false,
      hasNextPage: true,
      startCursor: "",
      endCursor: "",
    },
  };
}
