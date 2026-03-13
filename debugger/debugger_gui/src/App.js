import React, { useState } from 'react';
import { Container } from '@mui/material';
// import PullButton from './components/pull-button/PullButton'; // Import the FetchButton component
import SyncSection from './components/sync-section/SyncSection'; // Import the FetchButton component

import Tree from './components/tree/Tree'; // Import the Tree component
import './App.css';

const App = () => {
    const [projectStructure, setProjectStructure] = useState(null);
    const [expanded, setExpanded] = useState({});

    const handleExpandClick = (id) => {
        setExpanded((prevExpanded) => ({ ...prevExpanded, [id]: !prevExpanded[id] }));
    };

    const handleCheckboxChange = (nodeId, checked) => {
        console.log("Handle checkbox change on node: ", nodeId, " with checked: ", checked); // Log the checkbox change
    
        const updateNode = (nodes, pathParts, checked, forceCheck = false) => {
            return nodes.map((node) => {
                if (node.name === pathParts[0]) {
                    // Check if the node should be force-checked due to a child being checked
                    const shouldCheck = checked || forceCheck;
    
                    if (pathParts.length === 1) {
                        console.log("Node found: ", node.name, " With current checked: ", node.is_toggled);
                        return { ...node, is_toggled: shouldCheck, children: updateChildren(node.children, shouldCheck) };
                    }
    
                    // Recursively update children
                    if (node.children) {
                        const updatedChildren = updateNode(node.children, pathParts.slice(1), checked, shouldCheck);
                        return { ...node, is_toggled: shouldCheck, children: updatedChildren };
                    }
    
                    return { ...node, is_toggled: shouldCheck };
                }
                return node;
            });
        };
    
        // Function to update the state of child nodes
        const updateChildren = (children, checked) => {
            if (!children) return [];
            return children.map((child) => ({
                ...child,
                is_toggled: checked,
                children: updateChildren(child.children, checked)
            }));
        };
    
        setProjectStructure((prevStructure) => {
            if (!prevStructure) return prevStructure;
            const pathParts = nodeId.split('/');
            const updatedStructure = updateNode(prevStructure, pathParts, checked);
            return updatedStructure;
        });
    };

    const handleEmojiChange = (nodeId, emoji) => {
        console.log("Handle emoji change on node: ", nodeId, " with emoji: ", emoji);
    
        // Function to recursively propagate the emoji to all children but not update the ancestors
        const propagateEmojiToChildren = (node) => {
            if (!node.children) return node; // If no children, return the node as is
    
            const updatedChildren = node.children.map((child) => ({
                ...child,
                emoji, // Set the new emoji to the child node
                children: propagateEmojiToChildren(child).children, // Recursively propagate to deeper children
            }));
    
            return { ...node, children: updatedChildren }; // Update the node's children but not the node itself
        };
    
        const updateNode = (nodes, pathParts, emoji) => {
            return nodes.map((node) => {
                if (node.name === pathParts[0]) {
                    // Update the emoji of the node itself if this is the target node
                    let updatedNode = { ...node };
    
                    if (pathParts.length === 1) {
                        // This is the target node, update its emoji
                        updatedNode.emoji = emoji;
                    }
    
                    // If this node has children and we haven't reached the target node yet
                    if (node.children && pathParts.length > 1) {
                        const updatedChildren = updateNode(node.children, pathParts.slice(1), emoji);
                        updatedNode = { ...updatedNode, children: updatedChildren };
                    }
    
                    // If we've reached the target node, propagate the emoji to its children
                    if (pathParts.length === 1 && node.children) {
                        updatedNode.children = propagateEmojiToChildren(node).children;
                    }
    
                    return updatedNode;
                }
    
                return node; // No match, return the node as is
            });
        };
    
        setProjectStructure((prevStructure) => {
            if (!prevStructure) return prevStructure;
    
            const pathParts = nodeId.split('/');
            const updatedStructure = updateNode(prevStructure, pathParts, emoji);
    
            return updatedStructure;
        });
    };
    
    
    

    const defaultColor = '#ff0000'; // Define the default color

    const handleColorChange = (nodeId, color) => {
        console.log("Handle color change on node: ", nodeId, " with color: ", color); // Log the color change
        const amount = 50; // Define the amount to lighten the color

        const updateNode = (nodes, pathParts, color, isOriginalParent = false) => {
            console.log("HIT updateNode with color: ", color); // Log the color
            return nodes.map((node) => {
                if (node.name === pathParts[0]) {
                    let name = node.name;
                    let newColor = node.color;
                    let is_toggled = node.is_toggled;
                    let set_manually = node.set_manually;
        
                    // If the node is the target node
                    if (pathParts.length === 1) {
                        console.log("Node found: ", node.name, " With current color: ", node.color);
                        console.log("Setting color to: ", color);
                        console.log("Is original parent: ", isOriginalParent, " Set manually: ", set_manually);                        
                        if (isOriginalParent) {
                            set_manually = true;
                        }
                        newColor = color;
                    }
        
                    if (node.children) {
                        // Update children nodes
                        const updatedChildren = updateNode(node.children, pathParts.slice(1), color, isOriginalParent);
        
                        // Check and propagate the color to children if needed
                        const propagatedChildren = updatedChildren.map((child) => {
                            console.log("Checking child: ", child.name);
                            console.log("Child set manually: ", child.set_manually);
                            if (!child.set_manually) {
                                console.log("Propagating color to child: ", child.name);
                                const newPath = [...pathParts.slice(1), child.name];
                                return updateNode([child], newPath, lightenColor(color, amount), false)[0];
                            }
                            return child;
                        });
                        console.log("RETURN 1 node: ", node.name, " with color: ", newColor);
                        return {
                            ...node,
                            name: name,
                            color: newColor,
                            is_toggled: is_toggled,
                            set_manually: set_manually,
                            children: propagatedChildren
                        };
                    }
                    console.log("RETURN 2 node: ", node.name, " with color: ", newColor);
                    return { ...node, name: name, color: newColor, is_toggled, set_manually};
                }
                return node;
            });
        };
        
        // Helper function to lighten a color (example implementation)
        const lightenColor = (color, amount = 50) => {
            if (!color || typeof color !== 'string' || !color.startsWith('#') || color.length !== 7) {
                throw new Error('Invalid color format. Expected format is #RRGGBB. But got: ' + color);
            }
        
            const colorInt = parseInt(color.slice(1), 16);
            const r = Math.min(255, (colorInt >> 16) + amount);
            const g = Math.min(255, ((colorInt >> 8) & 0x00FF) + amount);
            const b = Math.min(255, (colorInt & 0x0000FF) + amount);
            const newColorInt = (r << 16) + (g << 8) + b;
            // Corrected console.log statement
            console.log(`Old color: ${color}, New color: #${newColorInt.toString(16).padStart(6, '0')}`); // Log the old and new color
            return `#${newColorInt.toString(16).padStart(6, '0')}`;
        };

        setProjectStructure((prevStructure) => {
            if (!prevStructure) return prevStructure;
            const pathParts = nodeId.split('/');
            const updatedStructure = updateNode(prevStructure, pathParts, color, true);
            console.log('Updated structure:', updatedStructure);
            return updatedStructure;
        });
    }; 


    return (
        <div className='app-container'>
            <div className='app-header'>
                Cluster Labs Debugger v0
            </div>
            {/* <PullButton setProjectStructure={setProjectStructure} /> */}
            {/* <SyncSection setProjectStructure={setProjectStructure} /> */}
            <SyncSection projectStructure={projectStructure} setProjectStructure={setProjectStructure} />
            <Tree
                projectStructure={projectStructure}
                expanded={expanded}
                handleExpandClick={handleExpandClick}
                handleCheckboxChange={handleCheckboxChange}
                handleColorChange={handleColorChange}
                handleEmojiChange={handleEmojiChange}
            />
        </div>
    );
};

export default App;
