export const getStyleValue = (className: string, property: string, defaultValue: string = "none"): string => {
    if (typeof document !== 'undefined') {
        const element = document.createElement("div");
        element.setAttribute("class", className);
        document.body.appendChild(element);
        const style = window.getComputedStyle(element);
        const value = style.getPropertyValue(property);
        document.body.removeChild(element);
        return value || defaultValue;
    }
    return defaultValue; // Return default value if not in a browser environment
};