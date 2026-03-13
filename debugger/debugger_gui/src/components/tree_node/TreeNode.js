import './TreeNode.css';
import React from 'react';
import plusIcon from '../../assets/collapsed.png';
import minusIcon from '../../assets/expanded.png';
import colorIcon from '../../assets/color-picker.png'; // Import your custom color icon
import EmojiPicker from '../emoji-picker/EmojiPicker';

const TreeNode = ({ node, nodeId, expanded, handleExpandClick, handleCheckboxChange, handleColorChange, handleEmojiChange, renderTree }) => (
    <div className="tree-node">
        <div className="tree-node-content">
            <div className="tree-node-content-main">
                {node.children && node.children.length > 0 && (
                    <button className="expand-button" onClick={() => handleExpandClick(nodeId)}>
                        <img src={expanded[nodeId] ? minusIcon : plusIcon} alt="Expand/Collapse Icon" />
                    </button>
                )}
                <input
                    type="checkbox"
                    checked={node.is_toggled}
                    onChange={(e) => handleCheckboxChange(nodeId, e.target.checked)}
                />
                {/* Pass node.emoji along with handleEmojiChange */}
                <EmojiPicker 
                    defaultEmoji={node.emoji} 
                    handleEmojiChange={(emoji) => handleEmojiChange(nodeId, emoji)} 
                />
                <span className="tree-node-text" style={{ color: node.color || '#000000' }}>{node.name}</span>
            </div>
            <div className="tree-node-content-secondary">
                <div className="color-picker-wrapper">
                    <input
                        type="color"
                        value={node.color || '#000000'}
                        onChange={(e) => handleColorChange(nodeId, e.target.value)}
                        style={{ display: 'none' }} // Hide the default color input
                        id={`color-picker-${nodeId}`}
                    />
                    <label htmlFor={`color-picker-${nodeId}`} className="color-picker-icon" style={{ backgroundColor: node.color || '#000000' }}>
                        <img src={colorIcon} alt="Color Picker Icon" />
                    </label>
                </div>
            </div>
        </div>
        {node.children && expanded[nodeId] && (
            <div className="tree-node-children">
                {node.children.map((childNode) => renderTree(childNode, nodeId))}
            </div>
        )}
    </div>
);

export default TreeNode;
