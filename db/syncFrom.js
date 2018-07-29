const { mongoShell } = require('./mongoShell');

class SyncFrom {
  getLastTortoiseKey(req) {
    const turtleID = req._id;
    const turtleSyncToLatestHistory = req.history[0];

    return mongoShell.command(mongoShell._syncFromStore, "READ", { _id: turtleID })
    .then(tortoiseSyncFromDocs => {
      const tortoiseSyncFromDoc = tortoiseSyncFromDocs[0];

      // If sync from doc already exists
      if (tortoiseSyncFromDoc) {
        const tortoiseSyncFromLatestHistory = tortoiseSyncFromDoc.history[0];

        // If doc exists but history never created for some reason
        if (!tortoiseSyncFromLatestHistory) {
          return 0;
        } else {
          // If last keys don't match, just start from 0
          if (tortoiseSyncFromLatestHistory.lastKey !== turtleSyncToLatestHistory.lastKey) {
            return 0;
          } else {
            return tortoiseSyncFromLatestHistory.lastKey;
          }
        }
      } else {
        return this.createSyncFromDoc(turtleID).then(() => 0);
      }
    })
  }

  createSyncFromDoc(turtleID) {
    const newHistory = { _id: turtleID, history: [] };
    return mongoShell.command(mongoShell._syncFromStore, "CREATE", newHistory)
  }

  insertNewDocsIntoStore(docs) {
    if (docs.length === 0) {
      console.log('FYI: No docs were sent over from turtle to insert.');
      return Promise.resolve();
    } else {
      return mongoShell.command(mongoShell._store, "CREATE_MANY", docs);
    }
  }

  updateSyncFromTurtleDoc(newSyncFromTurtleDoc) {
    return mongoShell.command(mongoShell._syncFromStore, "UPDATE", newSyncFromTurtleDoc)
  }


  findAllMissingLeafNodes(turtleMetaDocs) {
    // returns a list of all turtle leaf nodes that tortoise doesn't have
    const missingLeafNodes = [];

    const promises = turtleMetaDocs.map(turtleMetaDoc => {
      return mongoShell.command(mongoShell._meta, "READ", { _id: turtleMetaDoc._id })
        .then(tortoiseMetaDocArr => {
          let tortoiseMetaDoc = tortoiseMetaDocArr[0];
          console.log('tortoise metadoc:', tortoiseMetaDoc);

          if (tortoiseMetaDoc) {
            const newMetaDoc = this.createNewMetaDoc(tortoiseMetaDoc, turtleMetaDoc);
            console.log('new metadoc after merge:', newMetaDoc);
            return this.findMissingLeafNodesOfDoc(newMetaDoc)
              .then(idRevs => {
                console.log('leaf nodes that are missing from tortoise:', idRevs);
                missingLeafNodes.push(...idRevs);
                // update existing metaDoc
                return mongoShell.command(mongoShell._meta, "UPDATE", newMetaDoc);
              });
          } else {
            // if we recieve a document with one branch that has been deleted, ignore it
            if (turtleMetaDoc._winningRev) {
              missingLeafNodes.push(turtleMetaDoc._id + '::' + turtleMetaDoc._winningRev);
              // insert turtleMetaDoc
              return mongoShell.command(mongoShell._meta, "CREATE", turtleMetaDoc);
            }
          }
        })
    });

    return Promise.all(promises).then(() => {
      return missingLeafNodes;
    });
  }

  createNewMetaDoc(tortoiseMetaDoc, turtleMetaDoc) {
    const tortoiseRevTree = tortoiseMetaDoc._revisions;
    const turtleRevTree = turtleMetaDoc._revisions;
    // console.log('tortoiseRevTree', JSON.stringify(tortoiseRevTree, undefined, 2));
    // console.log('turtleRevTree', JSON.stringify(turtleRevTree, undefined, 2));
    const mergedRevTree = this.mergeRevTrees(tortoiseRevTree, turtleRevTree);
    // console.log('mergedRevTree', JSON.stringify(mergedRevTree, undefined, 2));

    return {
      _id: tortoiseMetaDoc._id,
      _revisions: mergedRevTree,
      _winningRev: this.getWinningRev(mergedRevTree),
      _leafRevs: this.collectActiveLeafRevs(mergedRevTree)
    };
  }

  mergeRevTrees(node1, node2) {
    const node1Children = node1[2];
    const node2Children = node2[2];

    const commonNodes = this.findCommonNodes(node1Children, node2Children);

    if (commonNodes) {
      // append different nodes in node2 to node1's children subarray
      const node2ChildrenDiffs = this.getNode2ChildrenDiffs(node1Children, node2Children);
      node1[2] = [...node1Children, ...node2ChildrenDiffs];

      for (let i = 0; i < commonNodes.length; i++) {
        let commonNodesPair = commonNodes[i];
        this.mergeRevTrees(commonNodesPair[0], commonNodesPair[1]);
      }

    } else {
      // fork
      node1[2] = [...node1Children, ...node2Children];
    }

    return node1;
  }

  findCommonNodes(node1Children, node2Children) {
    let commonNodes = [];
    for (let i = 0; i < node1Children.length; i++) {
      let node1Child = node1Children[i];
      for (let j = 0; j < node2Children.length; j++) {
        let node2Child = node2Children[j];
        if (node2Child[0] === node1Child[0]) {
          commonNodes.push([node1Child, node2Child]);
        }
      }
    }

    return commonNodes.length === 0 ? null : commonNodes;
  }

  getNode2ChildrenDiffs(node1Children, node2Children) {
    const node1ChildRevs = node1Children.map(node => node[0]);
    return node2Children.filter(node2Child => !node1ChildRevs.includes(node2Child[0]));
  }

  getWinningRev(node) {
    const leafRevs = this.collectActiveLeafRevs(node);

    return leafRevs.sort((a, b) => {
      let [revNumA, revHashA] = a.split('-');
      let [revNumB, revHashB] = b.split('-');
      revNumA = parseInt(revNumA, 10);
      revNumB = parseInt(revNumB, 10);

      if (revNumA > revNumB) {
        return -1;
      } else if (revNumA < revNumB) {
        return 1;
      } else {
        if (revHashA > revHashB) {
          return -1;
        } else {
          return 1;
        }
      }
    })[0];
  }

  collectActiveLeafRevs(node, leafRevs = []) {
    if (node[2].length === 0 && !node[1]._deleted) {
      leafRevs.push(node[0]);
    }

    for (let i = 0; i < node[2].length; i++) {
      this.collectActiveLeafRevs(node[2][i], leafRevs);
    }

    return leafRevs;
  }

  collectAllLeafRevs(node, leafRevs = []) {
    if (node[2].length === 0) {
      leafRevs.push(node[0]);
    }

    for (let i = 0; i < node[2].length; i++) {
      this.collectAllLeafRevs(node[2][i], leafRevs);
    }

    return leafRevs;
  }

  findMissingLeafNodesOfDoc(metaDoc) {
    const leafRevs = this.collectAllLeafRevs(metaDoc._revisions);
    const docId = metaDoc._id;
    const leafIdRevs = leafRevs.map(rev => docId + '::' + rev);

    return mongoShell.getStoreDocsByIdRevs(leafIdRevs)
      .then(tortoiseDocs => {
        const existingTortoiseIdRevs = tortoiseDocs.map(doc => doc._id_rev);
        return leafIdRevs.filter(idRev => !existingTortoiseIdRevs.includes(idRev));
      });
  }
}

module.exports = { SyncFrom };
