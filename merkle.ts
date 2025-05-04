import { LeanIMT } from "@zk-kit/lean-imt"
import { poseidon2Hash } from "@zkpassport/poseidon2"

// Hash function used to compute the tree nodes.
const hash = (a, b) => poseidon2Hash([a, b])

// To create an instance of a LeanIMT, you must provide the hash function.
const tree = new LeanIMT(hash)

tree.insert(1n)
tree.insert(2n)
tree.insert(3n)
tree.insert(4n)
tree.insert(5n)

const proof = tree.generateProof(3)
console.log(tree.root)
console.log(tree.leaves);
console.log(tree.depth);
console.log(proof)

const merkleProofIndices = []
const merkleProofSiblings = proof.siblings

for (let i = 0; i < tree.depth; i += 1) {
    merkleProofIndices.push((proof.index >> i) & 1)

    if (merkleProofSiblings[i] === undefined) {
        merkleProofSiblings[i] = 0n
    }
}

console.log(merkleProofIndices);
console.log(merkleProofSiblings);

