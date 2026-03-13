import React from 'react';
import PullButton from '../pull-button/PullButton';
import PushButton from '../push-button/PushButton';
import ColorReset from '../color-reset/ColorReset';
import './SyncSection.css'; // Import the CSS file

const SyncSection = ({ projectStructure, setProjectStructure }) => {
    return (
        <div className="sync-section-container">
            <PullButton setProjectStructure={setProjectStructure} />
            <ColorReset setProjectStructure={setProjectStructure} />
            <PushButton projectStructure={projectStructure} setProjectStructure={setProjectStructure} />
        </div>
    );
};

export default SyncSection;
