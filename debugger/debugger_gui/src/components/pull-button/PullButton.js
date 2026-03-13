import React from 'react';
import { Button } from '@mui/material';
import axios from 'axios';
import pullImg from '../../assets/pull.png'; // Adjust the path according to your project structure
import './PullButton.css';


const PullButton = ({ setProjectStructure }) => {
    const pullStructure = async () => {
        try {
            const response = await axios.get('http://127.0.0.1:6969/pull_structure');
            console.log('Project structure:', response.data);
            setProjectStructure(response.data);
        } catch (error) {
            console.error('Error fetching project structure:', error);
        }
    };

    return (
        <div className="pull-button-container">
            <img src={pullImg} alt="Project Structure" className="pull-button-img" />
            <div className="pull-button-content">
                <button className="pull-button" onClick={pullStructure}>
                    Pull
                </button>
                <p>Pull debugger config from backend</p>
            </div>
        </div>
    );
};

export default PullButton;
