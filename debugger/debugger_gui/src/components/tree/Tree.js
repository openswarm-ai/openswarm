import React from 'react';
import TreeNode from '../tree_node/TreeNode';
import './Tree.css';

const Tree = ({ projectStructure, expanded, handleExpandClick, handleCheckboxChange, handleColorChange, handleEmojiChange}) => {
    const renderTree = (node, parentId = '') => {
        const nodeId = parentId ? `${parentId}/${node.name}` : node.name;

        return (
            <TreeNode
                key={nodeId}
                node={node}
                nodeId={nodeId}
                expanded={expanded}
                handleExpandClick={handleExpandClick}
                handleCheckboxChange={handleCheckboxChange}
                handleColorChange={handleColorChange}
                handleEmojiChange={handleEmojiChange}
                renderTree={renderTree}
            />
        );
    };

    if (!Array.isArray(projectStructure)) return null; // Ensure projectStructure is an array

    return (
        <div className='tree-container'>
            {projectStructure.map((node) => renderTree(node))}
        </div>
    );
};

export default Tree;
