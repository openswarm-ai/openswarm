import React from 'react';
import axios from 'axios';
import pushImg from '../../assets/push.png'; // Adjust the path according to your project structure
import './PushButton.css'; // Import the CSS file

const PushButton = ({ projectStructure, setProjectStructure }) => {
    const pushStructure = async () => {
        try {
            console.log("Pushing project structure to backend: ", projectStructure);
            const response = await axios.post('http://127.0.0.1:6969/push_structure', {
                projectStructure // Include the projectStructure in the POST request body
            });
            console.log('Project structure pushed:', response.data);
            setProjectStructure(response.data);
        } catch (error) {
            console.error('Error pushing project structure:', error);
        }
    };

    return (
        <div className="push-button-container">
            <div className="push-button-content">
                <button className="push-button" onClick={pushStructure}>
                    Push
                </button>
                <p>Push debugger config to backend</p>
            </div>
            <img src={pushImg} alt="Project Structure" className="push-button-img" />
        </div>
    );
};

export default PushButton;
